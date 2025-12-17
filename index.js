const express = require('express')
const cors = require('cors');
const app = express();
require('dotenv').config();
const { MongoClient, ServerApiVersion, ObjectId, } = require('mongodb');
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
                // query.displayName = {$regex: searchText, $options: 'i'}

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
                const { search } = req.query;

                let query = { status: 'pending' };

                if (search) {
                    query = {
                        ...query,
                        $or: [
                            { clubName: { $regex: search, $options: 'i' } },
                            { description: { $regex: search, $options: 'i' } },
                        ]
                    };
                }

                const clubs = await clubCollection.find(query).toArray();
                res.send(clubs);
            } catch (err) {
                console.error(err);
                res.status(500).send({ message: 'Failed to fetch clubs', error: err.message });
            }
        });


        // GET all clubs (optionally filtered by manager email or status)
        app.get('/club/manager', verifyFBToken, async (req, res) => {
            try {
                const { managerEmail, status } = req.query;
                const query = {};

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
        app.get('/clubs/:id', verifyFBToken, async (req, res) => {
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

        // UPDATE club (manager can edit own club)
        app.patch('/clubs/:id', verifyFBToken, async (req, res) => {
            try {
                const id = req.params.id;
                const updateData = req.body;

                // check if manager owns this club
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

                // check if manager owns this club
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
                const { status } = req.body; // approved / rejected / pending

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

        // DELETE club (manager can delete own club)
        app.delete('/events/:id', verifyFBToken, async (req, res) => {
            try {
                const id = req.params.id;

                // check if manager owns this club
                const event = await eventCollection.findOne({ _id: new ObjectId(id) });

                const result = await eventCollection.deleteOne({ _id: new ObjectId(id) });
                res.send(result);
            } catch (err) {
                console.error(err);
                res.status(500).send({ message: 'Failed to delete club', error: err.message });
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
