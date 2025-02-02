const shopifyService = require('../services/shopify.service');
const appmaxService = require('../services/appmax.service');
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

      // Busca os dados completos do pedido se for um evento relacionado a pedido
      let appmaxOrder = data;
      if (data.id && event.startsWith('Order')) {
        try {
          appmaxOrder = await appmaxService.getOrderById(data.id);
        } catch (error) {
          logger.error(`Erro ao buscar dados completos do pedido #${data.id}:`, error);
          throw error;
        }
      }

      switch (event) {
        case 'OrderApproved':
          await this.handleOrderApproved(appmaxOrder);
          break;
          
        case 'OrderPaid':
          await this.handleOrderPaid(appmaxOrder);
          break;
          
        case 'OrderRefund':
          await this.handleOrderRefund(appmaxOrder);
          break;
          
        case 'PaymentNotAuthorized':
          await this.handlePaymentNotAuthorized(appmaxOrder);
          break;
          
        case 'OrderAuthorized':
          await this.handleOrderAuthorized(appmaxOrder);
          break;

        case 'PendingIntegration':
          logger.info(`Pedido ${appmaxOrder.id} pendente de integração`, appmaxOrder);
          break;

        case 'PixGenerated':
          await this.handlePixGenerated(appmaxOrder);
          break;

        case 'PixExpired':
          await this.handlePixExpired(appmaxOrder);
          break;

        case 'OrderIntegrated':
          await this.handleOrderIntegrated(appmaxOrder);
          break;

        case 'BoletoExpired':
          await this.handleBoletoExpired(appmaxOrder);
          break;

        case 'ChargebackDispute':
          await this.handleChargebackDispute(appmaxOrder);
          break;

        case 'ChargebackWon':
          await this.handleChargebackWon(appmaxOrder);
          break;

        case 'OrderBilletCreated':
          await this.handleOrderBilletCreated(appmaxOrder);
          break;

        case 'OrderPixCreated':
          await this.handleOrderPixCreated(appmaxOrder);
          break;

        case 'OrderPaidByPix':
          await this.handleOrderPaid(appmaxOrder);
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

  async handleOrderPixCreated(data) {
    const order = await shopifyService.createOrUpdateOrder({
      appmaxOrder: data,
      status: 'pending',
      financialStatus: 'pending'
    });
    
    logger.info(`Pedido Appmax #${data.id} com Pix criado na Shopify: #${order.id}`);
  }
}

module.exports = new WebhookController(); 