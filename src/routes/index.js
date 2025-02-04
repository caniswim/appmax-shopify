const express = require('express');
const router = express.Router();

const webhookRoutes = require('./webhook.routes');
const ordersRoutes = require('./orders.routes');

router.use('/webhook', webhookRoutes);
router.use('/orders', ordersRoutes);

module.exports = router; 