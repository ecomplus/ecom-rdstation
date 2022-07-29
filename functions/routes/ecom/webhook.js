// read configured E-Com Plus app data
const getAppData = require('./../../lib/store-api/get-app-data')

const SKIP_TRIGGER_NAME = 'SkipTrigger'
const ECHO_SUCCESS = 'SUCCESS'
const ECHO_SKIP = 'SKIP'
const ECHO_API_ERROR = 'STORE_API_ERR'

exports.post = ({ appSdk }, req, res) => {
  // receiving notification from Store API
  const { storeId } = req

  /**
   * Treat E-Com Plus trigger body here
   * Ref.: https://developers.e-com.plus/docs/api/#/store/triggers/
   */
  const trigger = req.body

  // get app configured options
  getAppData({ appSdk, storeId })

    .then(appData => {
      if (
        Array.isArray(appData.ignore_triggers) &&
        appData.ignore_triggers.indexOf(trigger.resource) > -1
      ) {
        // ignore current trigger
        const err = new Error()
        err.name = SKIP_TRIGGER_NAME
        throw err
      }

      /* DO YOUR CUSTOM STUFF HERE */
      const { resource } = trigger
      if ((resource === 'orders' || resource === 'carts') && trigger.action !== 'delete') {
        const resourceId = trigger.resource_id || trigger.inserted_id
        if (resourceId && appData.rd_token) {
          const url = 'https://api.rd.services/platform/events'
          console.log(`Trigger for Store #${storeId} ${resourceId} => ${url}`)
          if (url) {
            appSdk.apiRequest(storeId, `${resource}/${resourceId}.json`)
              .then(async ({ response }) => {
                let customer
                const body = response.data
                if (resource === 'carts') {
                  const cart = body
                  if (cart.available && !cart.completed) {
                    const abandonedCartDelay = 12 * 1000 * 60
                    if (Date.now() - new Date(cart.created_at).getTime() >= abandonedCartDelay) {
                      const { customers } = cart
                      if (customers && customers[0]) {
                        const { response } = await appSdk.apiRequest(storeId, `customers/${customers[0]}.json`)
                        customer = response.data
                      }
                    } else {
                      return res.sendStatus(501)
                    }
                  } else {
                    return res.sendStatus(204)
                  }
                }
                if (resource === 'orders') {
                  const { buyers } = body
                  if (buyers && buyers[0]) {
                    const { response } = await appSdk.apiRequest(storeId, `customers/${buyers[0]}.json`)
                    customer = response.data
                  }
                }
                console.log(`> Sending ${resource} notification`)
                let data
                if (resource === 'orders') {
                  const financial = body && body.financial_status.current
                  const totalItems = body.items.length
                  const transaction = body.transactions[0]
                  const getMethod = transaction => {
                    const paymentMethod = transaction.payment_method && transaction.payment_method.code
                    if (paymentMethod === 'credit_card') {
                      return 'Credit Card'
                    } else {
                      return 'Others'
                    }
                  }
                  const paymentMethod = getMethod(transaction)
                  const total = body.amount && body.amount.total
                  const acceptedMarketing = body.accepts_marketing ? 'granted' : 'declined'
                  data = {
                    "event_type": "ORDER_PLACED",
                    "event_family":"CDP",
                    "payload": {
                      "name": customer.display_name,
                      "email": customer.main_email,
                      "cf_order_id": body._id,
                      "cf_order_total_items": totalItems,
                      "cf_order_status": financial,
                      "cf_order_payment_method": paymentMethod,
                      "cf_order_payment_amount": total,
                      "legal_bases": [
                        {
                          "category": "communications",
                          "type":"consent",
                          "status": acceptedMarketing
                        }
                      ]
                    }
                  }
                } else if (resource === 'carts') {

                }
                return axios({
                  method: 'post',
                  url,
                  data: data
                })
              })
              .then(({ status }) => console.log(`> ${status}`))
              .catch(error => {
                if (error.response && error.config) {
                  const err = new Error(`#${storeId} ${resourceId} POST to ${url} failed`)
                  const { status, data } = error.response
                  err.response = {
                    status,
                    data: JSON.stringify(data)
                  }
                  err.data = JSON.stringify(error.config.data)
                  return console.error(err)
                }
                console.error(error)
              })
              .finally(() => {
                if (!res.headersSent) {
                  return res.sendStatus(200)
                }
              })
          }
        }
      }
    
      if (resource !== 'carts') {
        res.sendStatus(201)
      }
    })

    .catch(err => {
      if (err.name === SKIP_TRIGGER_NAME) {
        // trigger ignored by app configuration
        res.send(ECHO_SKIP)
      } else if (err.appWithoutAuth === true) {
        const msg = `Webhook for ${storeId} unhandled with no authentication found`
        const error = new Error(msg)
        error.trigger = JSON.stringify(trigger)
        console.error(error)
        res.status(412).send(msg)
      } else {
        // console.error(err)
        // request to Store API with error response
        // return error status code
        res.status(500)
        const { message } = err
        res.send({
          error: ECHO_API_ERROR,
          message
        })
      }
    })
}
