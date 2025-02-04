const express = require('express');
const router = express.Router();
const ordersController = require('../controllers/orders.controller');

// Busca um pedido por ID e tipo (appmax, shopify, woocommerce, session)
router.get('/:type/:id', ordersController.findOrder);

// Busca pedidos por intervalo de data
router.get('/', ordersController.getOrdersByDate);

// Atualiza o status de um pedido
router.patch('/:id', ordersController.updateOrder);

module.exports = router; 