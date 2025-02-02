const axios = require('axios');
const logger = require('../utils/logger');
const AppError = require('../utils/AppError');

class AppmaxService {
  constructor() {
    this.client = axios.create({
      baseURL: process.env.APPMAX_API_URL || 'https://api.appmax.com.br/v2',
      headers: {
        'Authorization': `Bearer ${process.env.APPMAX_API_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
  }

  async getOrderById(orderId) {
    try {
      logger.info(`Buscando dados completos do pedido Appmax #${orderId}`);
      
      const { data } = await this.client.get(`/sales/orders/${orderId}`);
      
      if (!data || !data.data) {
        throw new AppError(`Pedido #${orderId} não encontrado na Appmax`, 404);
      }

      logger.info(`Dados do pedido Appmax #${orderId} obtidos com sucesso`);
      return data.data;
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }

      logger.error(`Erro ao buscar pedido #${orderId} na Appmax:`, error);
      throw new AppError(
        `Erro ao buscar dados do pedido na Appmax: ${error.message}`,
        error.response?.status || 500
      );
    }
  }
}

module.exports = new AppmaxService(); 