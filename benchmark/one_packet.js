var net = require('net')
var socketServer;
var serverSockets = []
var HOST = '127.0.0.1'
var PORT = 3000;
var EasySock = require('..')
var jsonstringify = JSON.stringify.bind(JSON)
var jsonparse = JSON.parse.bind(JSON)

function createServer(onData) {
  onData = onData || function (socket) {
      return function (data) {
        socket.write(data)
      }
    }

  socketServer = net.createServer(function (socket) {
    serverSockets.push(socket)
    socket.on('data', onData(socket))
  })
  socketServer.listen(PORT)

  return socketServer;
}

function createEasySocket(_options) {
  var options = {
    ip: HOST,
    port: PORT,
  };

  for (var k in _options) {
    options[k] = _options[k]
  }
  var socket = new EasySock(options)

  socket.isReceiveComplete = function (packet) {
    return packet.length
  }
  socket.encode = function (data, seq) {
    data.seq = seq
    return new Buffer(jsonstringify(data))
  }
  socket.decode = function (data) {
    data = jsonparse(data)
    data.result = data.userid
    return data
  }

  return socket
}


suite('one packet', function () {
  var socket;
  before(function () {
    createServer()

    socket = createEasySocket()
  })

  after(function (done) {
    if (socketServer) {
      serverSockets.forEach(function (socket) {
        socket.end()
      })
      socketServer.close(done)
    } else {
      done()
    }
  })

  bench('one packet', function (next) {
    socket.write({
      userid: 11
    }, function (err, data) {
      next()
    })
  })

})