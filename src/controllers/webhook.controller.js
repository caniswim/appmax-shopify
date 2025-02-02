const shopifyService = require('../services/shopify.service');
const appmaxService = require('../services/appmax.service');
const logger = require('../utils/logger');
const AppError = require('../utils/AppError');

class WebhookController {
  /**
   * Verifica se os dados do pedido estão completos.
   * Aqui, por exemplo, consideramos que o pedido é completo se possuir o array "bundles"
   * (que contém os produtos) e informações do cliente.
   */
  hasFullOrderDetails(order) {
    return order && Array.isArray(order.bundles) && order.customer;
  }

  async handleAppmax(req, res, next) {
    try {
      // Extrai o evento e os dados do webhook
      const { event, data } = req.body;
      if (!event || !data) {
        throw new AppError('Dados do webhook inválidos', 400);
      }

      // Caso os dados do pedido estejam aninhados em "order", utiliza-os; caso contrário, usa o objeto data
      const orderData = data.order || data;

      // Extrai os nomes do cliente, considerando variações na nomenclatura (camelCase ou minúsculo)
      const firstName = orderData.customer?.firstName || orderData.customer?.firstname || 'N/A';
      const lastName = orderData.customer?.lastName || orderData.customer?.lastname || '';
      logger.info('Webhook recebido:', {
        event,
        orderId: orderData.id,
        status: orderData.status,
        customer: `${firstName} ${lastName}`.trim()
      });

      // Para eventos de pedidos (eventos que começam com "Order"), se os dados não estiverem completos,
      // busca os dados completos via API da Appmax. Assim evitamos chamar a API desnecessariamente,
      // o que estava ocasionando o erro de autorização.
      let appmaxOrder = orderData;
      if (event.startsWith('Order') && !this.hasFullOrderDetails(orderData)) {
        try {
          appmaxOrder = await appmaxService.getOrderById(orderData.id);
        } catch (error) {
          logger.error(`Erro ao buscar dados completos do pedido #${orderData.id}:`, error);
          throw error;
        }
      }

      // Processa o evento recebido conforme seu tipo
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
