// Creates the application database user on first MongoDB start.
// MONGO_APP_USER and MONGO_APP_PASSWORD are passed via environment
// variables in docker-compose.prod.yml.
//
// This script runs inside mongosh via docker-entrypoint-initdb.d/.

const appUser = process.env.MONGO_APP_USER || 'appuser';
const appPassword = process.env.MONGO_APP_PASSWORD || 'apppassword';

db = db.getSiblingDB('cryptowithalgo');

db.createUser({
  user: appUser,
  pwd: appPassword,
  roles: [{ role: 'readWrite', db: 'cryptowithalgo' }],
});
