const express = require('express');
const webhookController = require('../controllers/webhook.controller');

const router = express.Router();

router.post('/appmax', webhookController.handleWebhook.bind(webhookController));

module.exports = router; 