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
        case 'OrderPaid':
        case 'OrderApproved':
        case 'PixPaid':
          await this.handleOrderPaid(data);
          break;
          
        case 'OrderPendingIntegration':
          logger.info(`Pedido #${data.id} pendente de integração`);
          break;
          
        case 'OrderRefund':
        case 'OrderChargedback':
          await this.handleOrderRefund(data);
          break;
          
        case 'PixGenerated':
        case 'OrderIntegrated':
        case 'OrderAuthorized':
          await this.handleOrderPending(data);
          break;
          
        case 'PixExpired':
        case 'OrderBilletOverdue':
          await this.handleOrderCancelled(data);
          break;
          
        case 'OrderChargebackInDispute':
          await this.handleChargebackInDispute(data);
          break;
          
        case 'OrderChargebackWon':
          await this.handleChargebackWon(data);
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

  async handleOrderCancelled(data) {
    const order = await shopifyService.cancelOrder(data);
    logger.info(`Pedido Appmax #${data.id} cancelado na Shopify: #${order.id}`);
  }

  async handleOrderPending(data) {
    const order = await shopifyService.createOrUpdateOrder({
      appmaxOrder: data,
      status: 'pending',
      financialStatus: 'pending'
    });
    
    logger.info(`Pedido Appmax #${data.id} criado/atualizado na Shopify como pendente: #${order.id}`);
  }

  async handleChargebackInDispute(data) {
    const order = await shopifyService.createOrUpdateOrder({
      appmaxOrder: data,
      status: 'dispute',
      financialStatus: 'pending',
      tags: ['chargeback_in_dispute']
    });
    
    logger.info(`Pedido Appmax #${data.id} marcado como em disputa de chargeback na Shopify: #${order.id}`);
  }

  async handleChargebackWon(data) {
    const order = await shopifyService.createOrUpdateOrder({
      appmaxOrder: data,
      status: 'paid',
      financialStatus: 'paid',
      tags: ['chargeback_won']
    });
    
    logger.info(`Pedido Appmax #${data.id} marcado como chargeback ganho na Shopify: #${order.id}`);
  }
}

module.exports = new WebhookController(); 