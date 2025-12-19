const express = require('express')
const cors = require('cors');
const app = express();
require('dotenv').config();
const { MongoClient, ServerApiVersion, ObjectId, } = require('mongodb');
const stripe = require('stripe')(process.env.STRIPE_SECRET);
const port = process.env.PORT || 3000

// middleware
app.use(express.json());
app.use(cors());

const admin = require("firebase-admin");

const serviceAccount = require("./firebase-admin.json");

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});


const verifyFBToken = async (req, res, next) => {
    const token = req.headers.authorization;

    if (!token) {
        return res.status(401).send({ message: 'unauthorized access' })
    }

    try {
        const idToken = token.split(' ')[1];
        const decoded = await admin.auth().verifyIdToken(idToken);
        console.log('decoded in the token', decoded);
        req.decoded_email = decoded.email;
        next();
    }
    catch (err) {
        return res.status(401).send({ message: 'unauthorized access' })
    }


}

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.tmeirwi.mongodb.net/?appName=Cluster0`;


// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});


async function run() {
    try {
        // Connect the client to the server	(optional starting in v4.7)
        // await client.connect();

        const db = client.db('circlesphere_db');
        const userCollection = db.collection('users');
        const clubCollection = db.collection('clubs')
        const eventCollection = db.collection('events')
        const paymentsCollection = db.collection('payments');
        const membershipsCollection = db.collection('memberships');
        const eventRegistrationsCollection = db.collection('eventRegistrations');

        const verifyAdmin = async (req, res, next) => {
            const email = req.decoded_email;
            const query = { email };
            const user = await userCollection.findOne(query);

            if (!user || user.role !== 'admin') {
                return res.status(403).send({ message: 'forbidden access' });
            }

            next();
        }

        const verifymanager = async (req, res, next) => {
            const email = req.decoded_email;
            const query = { email };
            const user = await userCollection.findOne(query);

            if (!user || user.role !== 'manager') {
                return res.status(403).send({ message: 'forbidden access' });
            }

            next();
        }

        // User API 
        app.get('/users', verifyFBToken, async (req, res) => {
            const searchText = req.query.searchText;
            const query = {};

            if (searchText) {
                query.$or = [
                    { displayName: { $regex: searchText, $options: 'i' } },
                    { email: { $regex: searchText, $options: 'i' } },
                ]

            }

            const cursor = userCollection.find(query).sort({ createdAt: -1 });
            const result = await cursor.toArray();
            res.send(result);
        });

        app.get('/users/:email/role', async (req, res) => {
            const email = req.params.email;
            const query = { email }
            const user = await userCollection.findOne(query);
            res.send({ role: user?.role || 'user' })
        })


        app.post('/users', async (req, res) => {
            const user = req.body;
            user.role = 'member';
            user.createdAt = new Date();
            const email = user.email;
            const userExists = await userCollection.findOne({ email })

            if (userExists) {
                return res.send({ message: 'user exists' })
            }

            const result = await userCollection.insertOne(user);
            res.send(result);
        })


        app.patch('/users/:id/role', verifyFBToken, verifyAdmin, async (req, res) => {
            const id = req.params.id;
            const roleInfo = req.body;
            const query = { _id: new ObjectId(id) }
            const updatedDoc = {
                $set: {
                    role: roleInfo.role
                }
            }
            const result = await userCollection.updateOne(query, updatedDoc)
            res.send(result);
        })

        // Clubs API

        app.post('/clubs', verifyFBToken, async (req, res) => {
            try {
                const club = req.body;
                club.status = 'pending';
                club.createdAt = new Date();
                club.updatedAt = new Date();
                club.managerEmail = req.decoded_email;

                const result = await clubCollection.insertOne(club);
                res.send(result);
            } catch (err) {
                console.error(err);
                res.status(500).send({ message: 'Failed to create club', error: err.message });
            }
        });

        // GET /clubs?search=abc
        app.get('/clubs', async (req, res) => {
            try {
                const { search, sort } = req.query;

                const query = {};

                if (search) {
                    query.$or = [
                        { clubName: { $regex: search, $options: 'i' } }
                    ];
                }


                let sortOption = { createdAt: -1 };

                if (sort === 'oldest') {
                    sortOption = { createdAt: 1 };
                }
                else if (sort === 'highestFee') {
                    sortOption = { membershipFee: -1 };
                }
                else if (sort === 'lowestFee') {
                    sortOption = { membershipFee: 1 };
                }

                const result = await clubCollection
                    .find(query)
                    .sort(sortOption)
                    .toArray();

                res.send(result);

            } catch (error) {
                console.error(error);
                res.status(500).send({ message: 'Failed to fetch clubs' });
            }
        });



        // GET all clubs (optionally filtered by manager email or status)
        app.get('/club/manager', verifyFBToken, async (req, res) => {
            try {
                const { managerEmail, status } = req.query;
                const query = { status: 'approved' };


                if (managerEmail) query.managerEmail = managerEmail;
                if (status) query.status = status;

                const clubs = await clubCollection.find(query).sort({ createdAt: -1 }).toArray();
                res.send(clubs);
            } catch (err) {
                console.error(err);
                res.status(500).send({ message: 'Failed to fetch clubs', error: err.message });
            }
        });

        // GET single club by ID
        app.get('/clubs/:id', async (req, res) => {
            try {
                const id = req.params.id;
                const club = await clubCollection.findOne({ _id: new ObjectId(id) });
                if (!club) return res.status(404).send({ message: 'Club not found' });
                res.send(club);
            } catch (err) {
                console.error(err);
                res.status(500).send({ message: 'Failed to fetch club', error: err.message });
            }
        });

        // Featured clubs
        app.get('/featured-clubs', async (req, res) => {
            try {
                const clubs = await clubCollection
                    .find({ status: 'approved' })
                    .limit(6)
                    .toArray();

                res.send(clubs);
            } catch (err) {
                res.status(500).send({ message: 'Failed to load clubs' });
            }
        });




        // Member dashboard club
        app.get('/my-clubs', verifyFBToken, async (req, res) => {
            try {
                const userEmail = req.decoded_email;

                const memberships = await membershipsCollection.find({
                    userEmail,
                    status: 'active'
                }).toArray();

                const clubIds = memberships.map(m => new ObjectId(m.clubId));

                const clubs = await clubCollection.find({
                    _id: { $in: clubIds }
                }).toArray();

                const myClubs = memberships.map(membership => {
                    const club = clubs.find(
                        c => c._id.toString() === membership.clubId
                    );

                    return {
                        _id: club?._id,
                        clubName: club?.clubName,
                        location: club?.location,
                        bannerImage: club?.bannerImage,
                        status: membership.status,
                        joinedAt: membership.joinedAt,
                        expiresAt: membership.expiresAt || null
                    };
                });

                res.send(myClubs);
            } catch (error) {
                console.error(error);
                res.status(500).send({ message: 'Failed to load my clubs' });
            }
        });


        // UPDATE club (manager can edit own club)
        app.patch('/clubs/:id', verifyFBToken, async (req, res) => {
            try {
                const id = req.params.id;
                const updateData = req.body;

                const club = await clubCollection.findOne({ _id: new ObjectId(id) });
                if (!club) return res.status(404).send({ message: 'Club not found' });
                if (club.managerEmail !== req.decoded_email)
                    return res.status(403).send({ message: 'You are not allowed to edit this club' });

                updateData.updatedAt = new Date();

                const result = await clubCollection.updateOne(
                    { _id: new ObjectId(id) },
                    { $set: updateData }
                );
                res.send(result);
            } catch (err) {
                console.error(err);
                res.status(500).send({ message: 'Failed to update club', error: err.message });
            }
        });

        // DELETE club (manager can delete own club)
        app.delete('/clubs/:id', verifyFBToken, async (req, res) => {
            try {
                const id = req.params.id;

                const club = await clubCollection.findOne({ _id: new ObjectId(id) });
                if (!club) return res.status(404).send({ message: 'Club not found' });
                if (club.managerEmail !== req.decoded_email)
                    return res.status(403).send({ message: 'You are not allowed to delete this club' });

                const result = await clubCollection.deleteOne({ _id: new ObjectId(id) });
                res.send(result);
            } catch (err) {
                console.error(err);
                res.status(500).send({ message: 'Failed to delete club', error: err.message });
            }
        });

        // ADMIN: Approve/Reject clubs
        app.patch('/clubs/:id/status', verifyFBToken, verifyAdmin, async (req, res) => {
            try {
                const id = req.params.id;
                const { status } = req.body;

                const result = await clubCollection.updateOne(
                    { _id: new ObjectId(id) },
                    { $set: { status, updatedAt: new Date() } }
                );

                res.send(result);
            } catch (err) {
                console.error(err);
                res.status(500).send({ message: 'Failed to update status', error: err.message });
            }
        });

        //  Events API----
        app.post('/events', verifyFBToken, async (req, res) => {
            try {
                const event = req.body;
                event.createdAt = new Date();

                const result = await eventCollection.insertOne(event);
                res.send(result);
            } catch (err) {
                console.error(err);
                res.status(500).send({ message: 'Failed to create club', error: err.message });
            }
        });

        // Get all events 
        app.get('/events', async (req, res) => {
            const search = req.query.search;
            const query = {};

            if (search) {
                query.$or = [
                    { title: { $regex: search, $options: 'i' } },
                ]

            }

            const cursor = eventCollection.find(query).sort({ createdAt: -1 });
            const result = await cursor.toArray();
            res.send(result);
        });

        // GET all events (optionally filtered by manager email)
        app.get('/events/manager', verifyFBToken, async (req, res) => {
            try {
                const { managerEmail, status } = req.query;
                const query = {};

                if (managerEmail) query.managerEmail = managerEmail;
                if (status) query.status = status;

                const events = await eventCollection.find(query).sort({ createdAt: -1 }).toArray();
                res.send(events);
            } catch (err) {
                console.error(err);
                res.status(500).send({ message: 'Failed to fetch clubs', error: err.message });
            }
        });

        // GET single club by ID
        app.get('/events/:id', async (req, res) => {
            try {
                const id = req.params.id;
                const event = await eventCollection.findOne({ _id: new ObjectId(id) });
                if (!event) return res.status(404).send({ message: 'Club not found' });
                res.send(event);
            } catch (err) {
                console.error(err);
                res.status(500).send({ message: 'Failed to fetch club', error: err.message });
            }
        });

        // GET all members for all clubs of the logged-in manager
        app.get('/manager/members', verifyFBToken, async (req, res) => {
            const managerEmail = req.decoded_email;

            try {
                const clubs = await clubCollection.find({ managerEmail }).toArray();
                const clubIds = clubs.map(club => club._id.toString());

                const members = await membershipsCollection
                    .find({ clubId: { $in: clubIds } })
                    .toArray();

                // attach clubName
                const membersWithClubName = members.map(member => {
                    const club = clubs.find(c => c._id.toString() === member.clubId);
                    return {
                        ...member,
                        clubName: club?.clubName || 'N/A'
                    };
                });

                res.send(membersWithClubName);
            } catch (err) {
                console.error(err);
                res.status(500).send({ message: 'Failed to fetch members', error: err.message });
            }
        });


        // PATCH membership status
        app.patch('/membership/:membershipId/status', verifyFBToken, async (req, res) => {
            const { membershipId } = req.params;
            const { status } = req.body;

            try {
                const result = await membershipsCollection.updateOne(
                    { _id: new ObjectId(membershipId) },
                    { $set: { status } }
                );
                res.send(result);
            } catch (err) {
                console.error(err);
                res.status(500).send({ message: 'Failed to update membership status', error: err.message });
            }
        });


        // Member Dashboard event
        app.get('/my-events', verifyFBToken, async (req, res) => {
            try {
                const userEmail = req.decoded_email;

                const registrations = await eventRegistrationsCollection.find({
                    userEmail
                }).toArray();

                const eventIds = registrations.map(r => new ObjectId(r.eventId));
                const events = await eventCollection.find({ _id: { $in: eventIds } }).toArray();

                const clubIds = events.map(e => new ObjectId(e.clubId));
                const clubs = await clubCollection.find({ _id: { $in: clubIds } }).toArray();

                const myEvents = registrations.map(reg => {
                    const event = events.find(e => e._id.toString() === reg.eventId);
                    const club = clubs.find(c => c._id.toString() === event.clubId);
                    return {
                        _id: reg._id,
                        eventTitle: event?.title,
                        location: event?.location,
                        eventDate: event?.eventDate,
                    };
                });

                res.send(myEvents);

            } catch (err) {
                console.error(err);
                res.status(500).send({ message: 'Failed to fetch events' });
            }
        });

        // GET all registrations
        app.get('/event-registrations/all', async (req, res) => {
            try {
                const registrations = await eventRegistrationsCollection
                    .find({})
                    .sort({ registeredAt: -1 })
                    .toArray();

                res.send(registrations);
            } catch (err) {
                console.error(err);
                res.status(500).send({ message: 'Failed to fetch registrations', error: err.message });
            }
        });



        // UPDATE event
        app.patch('/events/:id', verifyFBToken, async (req, res) => {
            try {
                const id = req.params.id;
                const updateData = req.body;

                const event = await eventCollection.findOne({ _id: new ObjectId(id) });

                const result = await eventCollection.updateOne(
                    { _id: new ObjectId(id) },
                    { $set: updateData }
                );
                res.send(result);
            } catch (err) {
                console.error(err);
                res.status(500).send({ message: 'Failed to update Event', error: err.message });
            }
        });

        // DELETE event (manager can delete own event)
        app.delete('/events/:id', verifyFBToken, async (req, res) => {
            try {
                const id = req.params.id;

                const event = await eventCollection.findOne({ _id: new ObjectId(id) });

                const result = await eventCollection.deleteOne({ _id: new ObjectId(id) });
                res.send(result);
            } catch (err) {
                console.error(err);
                res.status(500).send({ message: 'Failed to delete club', error: err.message });
            }
        });

        // payment related apis

        // Member dashboard payment
        app.get('/my-payments', verifyFBToken, async (req, res) => {
            try {
                const userEmail = req.decoded_email;

                const payments = await paymentsCollection.find({ userEmail }).sort({ createdAt: -1 }).toArray();

                const clubIds = payments.filter(p => p.type === 'membership').map(p => new ObjectId(p.clubId));
                const eventIds = payments.filter(p => p.type === 'event').map(p => new ObjectId(p.eventId));

                const clubs = await clubCollection.find({ _id: { $in: clubIds } }).toArray();
                const events = await eventCollection.find({ _id: { $in: eventIds } }).toArray();

                const paymentHistory = payments.map(p => {
                    let name = '';

                    if (p.type === 'membership') {
                        const club = clubs.find(c => c._id.toString() === p.clubId);
                        name = club?.clubName || 'Unknown Club';
                    } else if (p.type === 'event') {
                        const event = events.find(e => e._id.toString() === p.eventId);
                        name = event?.title || 'Unknown Event';
                    }

                    return {
                        _id: p._id,
                        amount: p.amount,
                        type: p.type,
                        name,
                        date: p.createdAt,
                        status: p.status
                    };
                });

                res.send(paymentHistory);

            } catch (err) {
                console.error(err);
                res.status(500).send({ message: 'Failed to fetch payment history' });
            }
        });

        // GET /manager/payments
        app.get('/manager/payments', verifyFBToken, async (req, res) => {
            try {
                const managerEmail = req.decoded_email;

                const clubs = await clubCollection.find({ managerEmail }).toArray();
                const clubIds = clubs.map(club => club._id.toString());

                const payments = await paymentsCollection.find({ clubId: { $in: clubIds } }).toArray();

                res.send(payments);
            } catch (err) {
                console.error(err);
                res.status(500).send({ message: 'Failed to fetch payments', error: err.message });
            }
        });

        // Admin payment dashboard
        app.get("/admin/payments", verifyFBToken, verifyAdmin, async (req, res) => {
            const payments = await paymentsCollection
                .find({})
                .sort({ createdAt: -1 })
                .toArray();

            res.send(payments);
        });

        // ADMIN dashboard stats
        app.get('/admin/stats', verifyFBToken, verifyAdmin, async (req, res) => {
            try {
                const totalUsers = await userCollection.countDocuments();

                const totalClubs = await clubCollection.countDocuments();
                const pendingClubs = await clubCollection.countDocuments({ status: 'pending' });
                const approvedClubs = await clubCollection.countDocuments({ status: 'approved' });
                const rejectedClubs = await clubCollection.countDocuments({ status: 'rejected' });

                const totalMemberships = await membershipsCollection.countDocuments();
                const totalEvents = await eventCollection.countDocuments();

                const payments = await paymentsCollection.aggregate([
                    { $match: { status: 'completed' } },
                    {
                        $group: {
                            _id: null,
                            totalAmount: { $sum: '$amount' }
                        }
                    }
                ]).toArray();

                const totalPayments = payments[0]?.totalAmount || 0;

                res.send({
                    totalUsers,
                    clubs: {
                        total: totalClubs,
                        pending: pendingClubs,
                        approved: approvedClubs,
                        rejected: rejectedClubs
                    },
                    totalMemberships,
                    totalEvents,
                    totalPayments
                });

            } catch (err) {
                res.status(500).send({ message: 'Failed to load admin stats' });
            }
        });

        // Admin payment split (Pie chart)
        app.get('/admin/payment-breakdown', verifyFBToken, verifyAdmin, async (req, res) => {

            const data = await paymentsCollection.aggregate([
                {
                    $group: {
                        _id: '$type',
                        total: { $sum: '$amount' }
                    }
                }
            ]).toArray();

            const formatted = data.map(item => ({
                name: item._id,
                value: item.total
            }));

            res.send(formatted);
        });



        // club payment 
        app.post('/payment-checkout-session', async (req, res) => {
            const clubInfo = req.body;
            const amount = parseInt(clubInfo.Fee) * 100;
            const session = await stripe.checkout.sessions.create({
                line_items: [
                    {
                        price_data: {
                            currency: 'usd',
                            unit_amount: amount,
                            product_data: {
                                name: `Please pay for: ${clubInfo.clubName}`
                            }
                        },
                        quantity: 1,
                    },
                ],
                mode: 'payment',
                metadata: {
                    clubId: clubInfo.clubId,
                },
                customer_email: clubInfo.memberEmail,
                success_url: `${process.env.SITE_DOMAIN}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
                cancel_url: `${process.env.SITE_DOMAIN}/payment-cancel`,
            })

            res.send({ url: session.url })
        })

        // Payment for Event
        app.post('/payment-checkout-session/event', async (req, res) => {
            const eventInfo = req.body;
            const amount = parseInt(eventInfo.Fee) * 100;
            const session = await stripe.checkout.sessions.create({
                line_items: [
                    {
                        price_data: {
                            currency: 'usd',
                            unit_amount: amount,
                            product_data: {
                                name: `Please pay for: ${eventInfo.eventName}`
                            }
                        },
                        quantity: 1,
                    },
                ],
                mode: 'payment',
                metadata: {
                    eventId: eventInfo.eventId,
                },
                customer_email: eventInfo.memberEmail,
                success_url: `${process.env.SITE_DOMAIN}/event-payment-success?session_id={CHECKOUT_SESSION_ID}`,
                cancel_url: `${process.env.SITE_DOMAIN}/payment-cancel`,
            })

            res.send({ url: session.url })
        })

        // Membership and payment collection api
        app.get('/verify-payment/:session_id', async (req, res) => {
            try {
                const sessionId = req.params.session_id;

                const session = await stripe.checkout.sessions.retrieve(sessionId);

                if (session.payment_status !== 'paid') {
                    return res.status(400).send({ message: 'Payment not completed yet' });
                }

                const paymentIntentId = session.payment_intent;

                const existingPayment = await paymentsCollection.findOne({
                    stripePaymentIntentId: paymentIntentId
                });

                if (existingPayment) {
                    return res.send({
                        message: 'Payment already verified',
                        payment: existingPayment
                    });
                }

                const paymentData = {
                    userEmail: session.customer_email,
                    amount: session.amount_total / 100,
                    type: 'membership',
                    clubId: session.metadata.clubId,
                    stripePaymentIntentId: paymentIntentId,
                    status: 'completed',
                    createdAt: new Date()
                };

                const paymentResult = await paymentsCollection.insertOne(paymentData);

                const existingMembership = await membershipsCollection.findOne({
                    userEmail: session.customer_email,
                    clubId: session.metadata.clubId
                });

                if (!existingMembership) {
                    const membership = {
                        userEmail: session.customer_email,
                        clubId: session.metadata.clubId,
                        status: 'active',
                        paymentId: paymentIntentId,
                        joinedAt: new Date()
                    };

                    await membershipsCollection.insertOne(membership);
                }

                res.send({
                    message: 'Payment verified & membership created',
                    paymentId: paymentResult.insertedId
                });

            } catch (err) {
                console.error(err);
                res.status(500).send({
                    message: 'Error verifying payment',
                    error: err.message
                });
            }
        });

        // Event verify
        app.get('/verify-event-payment/:session_id', async (req, res) => {
            try {
                const session = await stripe.checkout.sessions.retrieve(req.params.session_id);

                if (session.payment_status !== 'paid') {
                    return res.status(400).send({ message: 'Payment not completed' });
                }

                const paymentIntentId = session.payment_intent;

                const exists = await paymentsCollection.findOne({
                    stripePaymentIntentId: paymentIntentId
                });

                if (exists) {
                    return res.send({ message: 'Already registered for event' });
                }

                const paymentData = {
                    userEmail: session.customer_email,
                    amount: session.amount_total / 100,
                    type: 'event',
                    clubId: session.metadata.clubId,
                    stripePaymentIntentId: paymentIntentId,
                    status: 'completed',
                    createdAt: new Date()
                };

                const paymentResult = await paymentsCollection.insertOne(paymentData);
                const eventRegistrations = {
                    userEmail: session.customer_email,
                    eventId: session.metadata.eventId,
                    paymentId: paymentIntentId,
                    registeredAt: new Date()
                };

                await eventRegistrationsCollection.insertOne(eventRegistrations);

                res.send({
                    message: 'Event Registration Successful',
                    paymentId: paymentResult.insertedId
                });

            } catch (err) {
                res.status(500).send({ error: err.message });
            }
        });

        // Send a ping to confirm a successful connection
        await client.db("admin").command({ ping: 1 });
        console.log("Pinged your deployment. You successfully connected to MongoDB!");
    } finally {
        // Ensures that the client will close when you finish/error
        // await client.close();
    }
}
run().catch(console.dir);

app.get('/', (req, res) => {
    res.send('CircleSphere is Running')
})

app.listen(port, () => {
    console.log(`Example app listening on port ${port}`)
})
