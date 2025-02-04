const express = require('express');
const webhookController = require('../controllers/webhook.controller');

const router = express.Router();

router.post('/appmax', webhookController.handleWebhook.bind(webhookController));

// Nova rota para atualização de IDs
router.post('/order/update-ids', webhookController.handleOrderIdsUpdate.bind(webhookController));

module.exports = router; 