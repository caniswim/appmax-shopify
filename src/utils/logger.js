class Logger {
  info(message, ...args) {
    console.log(new Date().toISOString(), 'INFO:', message, ...args);
  }

  error(message, ...args) {
    console.error(new Date().toISOString(), 'ERROR:', message, ...args);
  }
}

module.exports = new Logger(); 