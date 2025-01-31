const express = require('express');
const webhookController = require('../controllers/webhook.controller');

const router = express.Router();

router.post('/appmax', webhookController.handleAppmax.bind(webhookController));

module.exports = router; 