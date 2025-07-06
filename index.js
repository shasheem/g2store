const apiVersion = "2023-08-16";
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY, {
    apiVersion: apiVersion
})

// BASE SETUP
// =============================================================================

// call the packages we need
const express = require("express"); // call express
const app = express(); // define our app using express
const bodyParser = require("body-parser");
const encodeBase64 = require("base-64");

// Laravel API helper class
class LaravelApi {
    constructor() {
        this.website = "https://g5mall.com/";
        this.baseUrl = this.website + 'api/'; // Laravel API endpoint
        this.headers = { 'Content-Type': 'application/json' };
    }

    async getProfile(token) {
        try {
            const options = {
                headers: {
                    ...this.headers,
                    'Authorization': `Bearer ${token}` // Laravel Bearer token format
                },
            };
            
            const res = await fetch(this.baseUrl + 'user/profile', options);
            return res;
        } catch (error) {
            console.error('Laravel API Error:', error);
            throw error;
        }
    }

    // Optional: Validate Laravel session token
    async validateToken(token) {
        try {
            const options = {
                headers: {
                    ...this.headers,
                    'Authorization': `Bearer ${token}`
                },
            };
            
            const res = await fetch(this.baseUrl + 'user/validate', options);
            return res;
        } catch (error) {
            console.error('Laravel Token Validation Error:', error);
            return null;
        }
    }
}

// configure app to use bodyParser()
// this will let us get the data from a POST
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

const port = process.env.PORT || 8080; // set our port

// ROUTES FOR OUR API
// =============================================================================
const router = express.Router(); // get an instance of the express Router

// Helper function to create error responses
function createResponseError(param) {
    return {
        success: false,
        message: param.message,
        code: param.code
    };
}

// Updated payment-intent-v4 endpoint for Laravel backend
router.post("/payment-intent-v4", async function (req, res) {
    const {
        amount,
        request3dSecure,
        currencyCode,
        captureMethod,
        orderId,
        email,
        cookieWoo, // This will be the Laravel token for authenticated users
    } = req.body;

    let emailUser = email;
    let authenticated = false;
    let larravelUser = null;

    // Handle Laravel authentication if token is provided
    if (cookieWoo !== null && cookieWoo !== undefined) {
        let laravelApi = new LaravelApi();
        
        try {
            const result = await laravelApi.getProfile(cookieWoo);
            
            if (result.ok) {
                const userData = await result.json();
                
                if (userData && userData.user) {
                    authenticated = true;
                    larravelUser = userData.user;
                    emailUser = userData.user.email;
                    console.log('Laravel User Authenticated:', userData.user.name || userData.user.email);
                } else {
                    console.log('Laravel authentication failed: Invalid user data');
                }
            } else {
                console.log('Laravel authentication failed: HTTP', result.status);
            }
        } catch (error) {
            console.error('Laravel API Error:', error);
            // Don't fail the payment, just proceed as guest
            console.log('Proceeding as guest due to Laravel API error');
        }
    }

    // Search for existing Stripe customer
    let customerResults = await stripe.customers.search({
        query: 'email:"' + emailUser + '"'
    });

    let customer = customerResults.data[0];

    // Create customer if not found
    if (!customer) {
        const customerData = {
            email: emailUser,
        };

        // Add additional customer data if Laravel user is authenticated
        if (authenticated && larravelUser) {
            if (larravelUser.name) customerData.name = larravelUser.name;
            if (larravelUser.phone) customerData.phone = larravelUser.phone;
            
            // Add metadata about Laravel user
            customerData.metadata = {
                laravel_user_id: larravelUser.id?.toString() || '',
                source: 'laravel_authenticated'
            };
        } else {
            customerData.metadata = {
                source: 'guest_checkout'
            };
        }

        customer = await stripe.customers.create(customerData);
    }

    console.log('Stripe Customer:', customer.id, customer.email);

    try {
        const params = {
            confirm: false,
            customer: customer.id,
            payment_method_types: ["card"],
            payment_method_options: {
                card: {
                    request_three_d_secure: request3dSecure || "automatic",
                },
            },
            metadata: {
                order_id: orderId || '',
                laravel_user_id: larravelUser?.id?.toString() || '',
                authenticated: authenticated.toString(),
                source: 'laravel_app'
            },
            amount: amount,
            currency: currencyCode || "usd",
            description: `Payment for ${emailUser}${orderId ? ` - Order #${orderId}` : ''}`,
            receipt_email: emailUser,
            capture_method: captureMethod || "automatic",
        };

        const paymentIntent = await stripe.paymentIntents.create(params);

        let response = {
            success: true,
            customer_id: customer.id,
            id: paymentIntent.id,
            client_secret: paymentIntent.client_secret,
        };

        // Add ephemeral key and setup intent for authenticated users
        if (authenticated) {
            try {
                const ephemeralKey = await stripe.ephemeralKeys.create({
                    customer: customer.id
                }, {
                    apiVersion: apiVersion
                });

                const setupIntent = await stripe.setupIntents.create({
                    customer: customer.id,
                    usage: 'off_session'
                });

                response = {
                    ...response,
                    ephemeral_key: ephemeralKey.secret,
                    setupIntent: setupIntent.client_secret
                };

                console.log('Added ephemeral key and setup intent for authenticated Laravel user');
            } catch (keyError) {
                console.warn('Failed to create ephemeral key/setup intent:', keyError);
                // Don't fail the payment intent, just log the warning
            }
        }

        console.log('Payment Intent created successfully:', paymentIntent.id);
        res.json(response);

    } catch (error) {
        console.error('Stripe Payment Intent Error:', error);
        res.json({
            success: false,
            message: "Transaction failed. Please check the card information and try again.",
            error: error.message
        });
    }
});

// Keep existing endpoints for backward compatibility
router.post("/payment-intent", function (req, res) {
    const body = req.body;

    stripe.paymentIntents.create(
        {
            confirm: true,
            payment_method_types: ['card'],
            payment_method: body.payment_method_id,
            return_url: body.returnUrl,
            amount: body.amount,
            currency: body.currencyCode || "usd",
            source: body.token, // token
            description: body.email,
            receipt_email: body.email,
            capture_method: body.captureMethod || 'automatic',
        },
        function (err, paymentIntent) {
            if (!err) {
                res.json({ success: true, id: paymentIntent.id, client_secret: paymentIntent.client_secret });
            } else {
                res.json({ success: false, message: "Transaction error" + JSON.stringify(err) });
            }
        }
    );
});

router.post("/payment", function (req, res) {
    const body = req.body;

    stripe.charges.create(
        {
            amount: body.amount,
            currency: body.currencyCode || "usd",
            source: body.token, // token
            description: body.email,
        },
        function (err, charge) {
            if (!err) {
                res.json({ success: true, message: "Payment has been charged!!" });
            } else {
                res.json({
                    success: false,
                    message: "Transaction failed. Please check the card information and try again."
                });
            }
        }
    );
});

router.post("/payment-intent-v2", function (req, res) {
    const body = req.body;

    stripe.paymentIntents.create(
        {
            confirm: false,
            payment_method_types: ['card'],
            amount: body.amount,
            currency: body.currencyCode || "usd",
            source: body.token, // token
            description: body.email,
            receipt_email: body.email,
            capture_method: body.captureMethod || 'automatic',
        },
        function (err, paymentIntent) {
            if (!err) {
                res.json({ success: true, id: paymentIntent.id, client_secret: paymentIntent.client_secret });
            } else {
                res.json({
                    success: false,
                    message: "Transaction failed. Please check the card information and try again."
                });
            }
        }
    );
});

router.post("/payment-intent-v3", async function (req, res) {
    const { amount, request3dSecure, currencyCode, token, email, captureMethod, orderId } = req.body;

    const customer = await stripe.customers.create({ email });

    try {
        const params = {
            confirm: false,
            customer: customer.id,
            payment_method_types: ['card'],
            payment_method_options: {
                card: {
                    request_three_d_secure: request3dSecure || 'automatic',
                },
            },
            metadata: {
                order_id: orderId,
            },
            amount: amount,
            currency: currencyCode || "usd",
            source: token, // token
            description: email,
            receipt_email: email,
            capture_method: captureMethod || 'automatic',
        }
        const paymentIntent = await stripe.paymentIntents.create(params);
        res.json({ success: true, id: paymentIntent.id, client_secret: paymentIntent.client_secret });
    } catch (error) {
        res.json({
            success: false,
            message: "Transaction failed. Please check the card information and try again."
        });
    }
});

router.get("/payment-intent/:id", async (req, res) => {
    try {
        const paymentIntent = await stripe.paymentIntents.retrieve(req.params.id)
        res.send(paymentIntent)
    } catch (error) {
        res.send(error)
    }
});

// Optional: Webhook endpoint for order completion in Laravel
router.post("/webhook", express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET; // Set this in your environment

    let event;

    try {
        event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    } catch (err) {
        console.log(`Webhook signature verification failed.`, err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Handle the event
    switch (event.type) {
        case 'payment_intent.succeeded':
            const paymentIntent = event.data.object;
            console.log('PaymentIntent was successful!', paymentIntent.id);
            
            // Optional: Notify your Laravel backend about successful payment
            if (paymentIntent.metadata.order_id) {
                try {
                    const laravelApi = new LaravelApi();
                    // You can add an endpoint to notify Laravel about payment success
                    // await laravelApi.notifyPaymentSuccess(paymentIntent.metadata.order_id, paymentIntent.id);
                } catch (error) {
                    console.error('Failed to notify Laravel backend:', error);
                }
            }
            break;
        default:
            console.log(`Unhandled event type ${event.type}`);
    }

    res.json({ received: true });
});

// REGISTER OUR ROUTES -------------------------------
// all of our routes will be prefixed with /
app.use("/", router);

// START THE SERVER
// =============================================================================
app.listen(port);
console.log("Laravel-compatible Stripe server running on port " + port);
