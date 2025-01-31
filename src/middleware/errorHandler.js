const logger = require('../utils/logger');

function errorHandler(err, req, res, next) {
  logger.error('Erro não tratado:', err);

  // Se for um erro conhecido, retorna a mensagem específica
  if (err.isOperational) {
    return res.status(err.statusCode || 500).json({
      success: false,
      message: err.message
    });
  }

  // Para erros desconhecidos, retorna uma mensagem genérica
  return res.status(500).json({
    success: false,
    message: 'Erro interno do servidor'
  });
}

module.exports = errorHandler; 