
var tcp = require('./lib/easy_sock');
module.exports = function () {
    tcp.apply(this, arguments)
};
exports.Udp = require('./lib/easy_udp');
exports.Tcp = tcp;