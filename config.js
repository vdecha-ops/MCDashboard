// Configuration is read entirely from environment variables so no secrets
// need to be committed to the repo. For local development, copy .env.example
// to .env and fill in your values. On Render, set these as Environment
// Variables in the service's dashboard instead.
require('dotenv').config();

const config = {
  MC_SERVER_URL: process.env.MC_SERVER_URL || '',
  MC_CLIENT_ID: process.env.MC_CLIENT_ID || '',
  MC_CLIENT_SECRET: process.env.MC_CLIENT_SECRET || '',
  SESSION_SECRET: process.env.SESSION_SECRET || 'dev-secret-change-me',
  PORT: process.env.PORT || 3000,
};

const required = ['MC_SERVER_URL', 'MC_CLIENT_ID', 'MC_CLIENT_SECRET'];
for (const key of required) {
  if (!config[key]) {
    console.warn(`Warning: environment variable ${key} is not set. See .env.example.`);
  }
}

module.exports = config;
