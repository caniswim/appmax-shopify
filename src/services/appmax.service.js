const axios = require('axios');
const logger = require('../utils/logger');
const AppError = require('../utils/AppError');

class AppmaxService {
  constructor() {
    this.client = axios.create({
      // Certifique-se de que a variável APPMAX_API_URL esteja definida corretamente (ex: 'https://api.appmax.com.br/v3')
      baseURL: process.env.APPMAX_API_URL || 'https://api.appmax.com.br/v3',
      headers: {
        // Agora o token é enviado no formato esperado: "HMAC-SHA256 key=<token>"
        'Authorization': `HMAC-SHA256 key=${process.env.APPMAX_API_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
  }
}

module.exports = new AppmaxService();
