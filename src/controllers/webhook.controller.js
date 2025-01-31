const shopifyService = require('../services/shopify.service');
const logger = require('../utils/logger');
const AppError = require('../utils/AppError');

class WebhookController {
  async handleAppmax(req, res, next) {
    try {
      const { event, data } = req.body;
      
      if (!event || !data) {
        throw new AppError('Dados do webhook inválidos', 400);
      }

      logger.info('Webhook recebido:', {
        event,
        orderId: data.id,
        status: data.status,
        customer: `${data.customer?.firstname} ${data.customer?.lastname}`
      });

      switch (event) {
        case 'OrderApproved':
          await this.handleOrderApproved(data);
          break;
          
        case 'OrderPaid':
          await this.handleOrderPaid(data);
          break;
          
        case 'OrderRefund':
          await this.handleOrderRefund(data);
          break;
          
        case 'PaymentNotAuthorized':
          await this.handlePaymentNotAuthorized(data);
          break;
          
        default:
          logger.info(`Evento não tratado: ${event}`);
      }

      res.status(200).json({ success: true });
    } catch (error) {
      if (error instanceof AppError) {
        return next(error);
      }
      next(new AppError('Erro interno ao processar webhook', 500));
    }
  }

  async handleOrderApproved(data) {
    const order = await shopifyService.createOrUpdateOrder({
      appmaxOrder: data,
      status: 'paid',
      financialStatus: 'paid'
    });
    
    logger.info(`Pedido Appmax #${data.id} criado/atualizado na Shopify: #${order.id}`);
  }

  async handleOrderPaid(data) {
    const order = await shopifyService.createOrUpdateOrder({
      appmaxOrder: data,
      status: 'paid',
      financialStatus: 'paid'
    });
    
    logger.info(`Pedido Appmax #${data.id} marcado como pago na Shopify: #${order.id}`);
  }

  async handleOrderRefund(data) {
    const order = await shopifyService.refundOrder(data);
    logger.info(`Pedido Appmax #${data.id} reembolsado na Shopify: #${order.id}`);
  }

  async handlePaymentNotAuthorized(data) {
    const order = await shopifyService.cancelOrder(data);
    logger.info(`Pedido Appmax #${data.id} cancelado na Shopify: #${order.id}`);
  }
}

module.exports = new WebhookController(); 