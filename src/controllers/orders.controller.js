const logger = require('../utils/logger');
const AppError = require('../utils/AppError');
const db = require('../database/db');

class OrdersController {
  async findOrder(req, res, next) {
    try {
      const { id, type = 'appmax' } = req.params;
      
      const order = await db.findOrderById(id, type);
      if (!order) {
        throw new AppError('Pedido não encontrado', 404);
      }

      res.json(order);
    } catch (error) {
      next(error);
    }
  }

  async getOrdersByDate(req, res, next) {
    try {
      const { startDate, endDate, platform } = req.query;

      if (!startDate || !endDate) {
        throw new AppError('Data inicial e final são obrigatórias', 400);
      }

      const orders = await db.getOrdersByDateRange(
        new Date(startDate),
        new Date(endDate),
        platform
      );

      res.json({
        total: orders.length,
        orders
      });
    } catch (error) {
      next(error);
    }
  }

  async updateOrder(req, res, next) {
    try {
      const { id } = req.params;
      const { status, metadata } = req.body;

      if (!status) {
        throw new AppError('Status é obrigatório', 400);
      }

      await db.updateOrderStatus(id, status, metadata);
      const updatedOrder = await db.findOrderById(id);

      res.json(updatedOrder);
    } catch (error) {
      next(error);
    }
  }
}

module.exports = new OrdersController(); 