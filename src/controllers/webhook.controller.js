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
          
        case 'OrderAuthorized':
          await this.handleOrderAuthorized(data);
          break;

        case 'PendingIntegration':
          logger.info(`Pedido ${data.id} pendente de integração`, data);
          break;

        case 'PixGenerated':
          await this.handlePixGenerated(data);
          break;

        case 'PixExpired':
          await this.handlePixExpired(data);
          break;

        case 'OrderIntegrated':
          await this.handleOrderIntegrated(data);
          break;

        case 'BoletoExpired':
          await this.handleBoletoExpired(data);
          break;

        case 'ChargebackDispute':
          await this.handleChargebackDispute(data);
          break;

        case 'ChargebackWon':
          await this.handleChargebackWon(data);
          break;

        case 'OrderBilletCreated':
          await this.handleOrderBilletCreated(data);
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

  async handleOrderAuthorized(data) {
    const order = await shopifyService.createOrUpdateOrder({
      appmaxOrder: data,
      status: 'pending',
      financialStatus: 'pending'
    });
    
    logger.info(`Pedido Appmax #${data.id} criado/atualizado na Shopify como pendente: #${order.id}`);
  }

  async handlePixGenerated(data) {
    const order = await shopifyService.createOrUpdateOrder({
      appmaxOrder: data,
      status: 'pending',
      financialStatus: 'pending'
    });
    
    logger.info(`Pedido Appmax #${data.id} com Pix gerado atualizado na Shopify: #${order.id}`);
  }

  async handlePixExpired(data) {
    const order = await shopifyService.cancelOrder(data);
    logger.info(`Pedido Appmax #${data.id} com Pix expirado cancelado na Shopify: #${order.id}`);
  }

  async handleOrderIntegrated(data) {
    const order = await shopifyService.createOrUpdateOrder({
      appmaxOrder: data,
      status: 'pending',
      financialStatus: 'pending'
    });
    
    logger.info(`Pedido Appmax #${data.id} integrado na Shopify: #${order.id}`);
  }

  async handleBoletoExpired(data) {
    const order = await shopifyService.cancelOrder(data);
    logger.info(`Pedido Appmax #${data.id} com boleto vencido cancelado na Shopify: #${order.id}`);
  }

  async handleChargebackDispute(data) {
    const order = await shopifyService.createOrUpdateOrder({
      appmaxOrder: data,
      status: 'under_review',
      financialStatus: 'pending'
    });
    
    logger.info(`Pedido Appmax #${data.id} em disputa de chargeback na Shopify: #${order.id}`);
  }

  async handleChargebackWon(data) {
    const order = await shopifyService.createOrUpdateOrder({
      appmaxOrder: data,
      status: 'authorized',
      financialStatus: 'paid'
    });
    
    logger.info(`Pedido Appmax #${data.id} com chargeback ganho na Shopify: #${order.id}`);
  }

  async handleOrderBilletCreated(data) {
    const order = await shopifyService.createOrUpdateOrder({
      appmaxOrder: data,
      status: 'pending',
      financialStatus: 'pending'
    });
    
    logger.info(`Pedido Appmax #${data.id} com boleto criado na Shopify: #${order.id}`);
  }
}

module.exports = new WebhookController(); 