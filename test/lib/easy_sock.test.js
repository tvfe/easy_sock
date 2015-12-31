var net = require('net')
var EasySock = require('../../')
var pedding = require('pedding')

var socketServer;
var serverSockets = []
var HOST = '127.0.0.1'
var PORT = 3000;

var jsonstringify = JSON.stringify.bind(JSON)
var jsonparse = JSON.parse.bind(JSON)

describe('test/lib/easy_sock.test.js', function () {
  beforeEach(function () {
    socketServer = null;
    serverSockets = []
  })
  afterEach(function (done) {
    if (socketServer) {
      socketServer.close(done)
      serverSockets.forEach(function (socket) {
        socket.end()
      })
    } else {
      done()
    }

  })

  it('should ok', function () {
    true.should.ok()
  })

  it('should work with one packet', function (done) {
    socketServer = net.createServer(function (socket) {
      serverSockets.push(socket)
      socket.on('data', function (data) {
        socket.write(data)
      })
    })
    socketServer.listen(PORT)

    var socket = new EasySock({
      ip: HOST,
      port: PORT,
    })

    socket.isReceiveComplete = function (packet) {
      return packet.length
    }
    socket.encode = function (data, seq) {
      data.seq = seq
      return new Buffer(jsonstringify(data))
    }
    socket.decode = function (data) {
      data = jsonparse(String(data))
      data.result = data.userid
      return data
    }

    socket.write({
      userid: 11
    }, function (err, data) {
      (!!err).should.false();

      data.should.eql(11)
      done()
    })
  })

  it('should work with multi packets', function (done) {
    done = pedding(done, 3)

    socketServer = net.createServer(function (socket) {
      serverSockets.push(socket)
      socket.on('data', function (data) {
        socket.write(data) // 三份数据都在一次 data 事件里面，因为客户端那边缓存了
      })
    })
    socketServer.listen(PORT)

    var socket = new EasySock({
      ip: HOST,
      port: PORT,
    })

    var onePacketLength;
    socket.isReceiveComplete = function (packet) {
      return onePacketLength
    }
    socket.encode = function (data, seq) {
      data.seq = seq
      var buf = new Buffer(jsonstringify(data))
      onePacketLength = buf.length
      return buf
    }
    socket.decode = function (data) {
      data = jsonparse(String(data))
      data.result = data.userid
      return data
    }

    socket.write({
      userid: 11
    }, function (err, data) {
      (!!err).should.false();

      data.should.eql(11)
      done()
    })

    socket.write({
      userid: 12
    }, function (err, data) {
      (!!err).should.false();

      data.should.eql(12)
      done()
    })

    socket.write({
      userid: 13
    }, function (err, data) {
      (!!err).should.false();

      data.should.eql(13)
      done()
    })
  })

  it('should error when connect timeout', function (done) {
    var socket = new EasySock({
      ip: '8.8.8.8',
      port: PORT,
      timeout: 100
    })

    socket.isReceiveComplete = function (packet) {
      return packet.length
    }
    socket.encode = function (data, seq) {
      data.seq = seq
      return new Buffer(jsonstringify(data))
    }
    socket.decode = function (data) {
      data = jsonparse(String(data))
      data.result = data.userid
      return data
    }

    socket.write({
      userid: 11
    }, function (err, data) {
      err.message.should.eql('easy_sock:TCP connect timeout(300ms)')

      done()
    })
  })


})