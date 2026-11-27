import { MongoClient, type Db } from 'mongodb';
import { config } from './config.js';

let connecting: Promise<MongoClient> | undefined;

// Connects on first use. Call from anywhere: const db = await getDb();
// Connections are opened up front (minPoolSize), so a burst of webhooks on a
// freshly started copy does not pay for thirty handshakes inside Pigeon's 5 s limit.
export async function getDb(): Promise<Db> {
  connecting ??= new MongoClient(config.mongoUrl, { minPoolSize: Number(process.env.SB_MONGO_MIN_POOL ?? 10), maxPoolSize: 50, serverSelectionTimeoutMS: 5000 })
    .connect()
    .catch((err) => {
      connecting = undefined; // let the next call try again
      throw err;
    });
  return (await connecting).db();
}
