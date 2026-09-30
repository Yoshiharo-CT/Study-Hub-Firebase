const { onRequest } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");

initializeApp();

const { handleApiRequest } = require("./api");

exports.api = onRequest({ cors: false }, handleApiRequest);
