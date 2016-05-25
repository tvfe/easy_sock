var net = require('net')
var EasySock = require('../../')
var pedding = require('pedding')

var socketServer;
var serverSockets = []
var HOST = '127.0.0.1'
var PORT = 3000;

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
    return packet.indexOf('}') + 1
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

function shouldNotBeHere() {
  throw new Error('should not be here')
}

describe('test/lib/easy_sock.test.js', function () {
  beforeEach(function () {
    socketServer = null;
    serverSockets = []
  })
  afterEach(function (done) {
    if (socketServer) {
      serverSockets.forEach(function (socket) {
        socket.end()
      })
      socketServer.close(done)
    } else {
      done()
    }

  })

  it('should ok', function () {
    true.should.ok()
  })

  it('should work with one packet', function (done) {

    createServer()

    var socket = createEasySocket()

    socket.write({
      userid: 11
    }, function (err, data) {
      (!!err).should.false();

      data.should.eql(11)
      done()
    })
  })

  it('should work with one packet and not call one task twice', function (done) {

    createServer(function (socket) {
      return function (data) {
        data = jsonparse(data)
        data.seq = 2;
        data = new Buffer(jsonstringify(data))
        socket.write(data)
      }
    })

    var socket = createEasySocket()

    socket.write({
      userid: 11
    }, function (err, data) {
      (!!err).should.false();

      data.should.eql(11)

      socket.write({
        userid: 12
      }, function (err, data) {
        shouldNotBeHere()
      })
    })

    setTimeout(function () {
      done()
    }, 200)
  })

  it('should work with multi packets', function (done) {
    done = pedding(done, 3)

    createServer()

    var socket = createEasySocket()

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
    var socket = createEasySocket({
      ip: '1.1.1.1',
      timeout: 100
    })

    socket.write({
      userid: 11
    }, function (err, data) {
      err.message.should.eql('easy_sock:TCP connect timeout(300ms)')
      socket.timers.connect._called.should.true()
      setImmediate(function () {
        socket.taskQueue.should.length(0)
        done()
      })
    })
    socket.taskQueue.should.length(1)
  })

  it('should error when write timeout', function (done) {

    createServer(function (socket) {
      return function (data) {
        // do nothing
      }
    })

    var socket = createEasySocket({
      timeout: 100
    })

    socket.write({
      userid: 11
    }, function (err, data) {
      err.message.should.eql('request timeout(100ms)')
      done()
    })
  })

  it('should not call connect timeout timer when unknown error occurs', function (done) {
    var socket = createEasySocket({
      ip: '1.1.1.1'
    })

    socket.timers.connect._idleTimeout.should.above(-1)

    socket.restore = function () {}
    socket.close()

    setImmediate(function () {
      socket.timers.connect._idleTimeout.should.eql(-1)
      done()
    })
  })

  it('should not call write timeout timer when unknown error occurs', function (done) {
    createServer(function (socket) {
      return function (data) {

      }
    })

    var socket = createEasySocket()

    socket.write({
      userid: 11
    }, function (err, data) {
    })

    setTimeout(function () {
      socket.timers.writes[1]._idleTimeout.should.above(-1)

      setTimeout(function () {
        socket.restore = function () {}
        socket.close()

        setTimeout(function () {
          socket.timers.writes[1]._idleTimeout.should.eql(-1)
          done()
        }, 10)
      }, 100)
    }, 100)

  })

  it('should close socket when idle, and recreate when write', function (done) {
    done = pedding(done, 2);

    createServer()

    var socket = createEasySocket({
      idleTimeout: 200
    })

    socket.once('close', function () {
      done()
    })

    setTimeout(function () {
      socket.write({
        userid: 11,
      }, function (err, data) {
        data.should.eql(11)
        done()
      })
    }, 300)
  })

  it('should error when no ip or port', function () {
    try{
      new EasySock({})
    } catch (e) {
      e.message.should.eql('needs config info: ip, port')
    }
  })

  it('should not close socket when idle and keepAlive', function (done) {
    createServer()

    var socket = createEasySocket({
      //idleTimeout: 200,
      keepAlive: true,
    })

    var closeCount = 0;
    socket.on('close', function () {
      closeCount++;
      closeCount.should.not.eql(2)
    })

    setTimeout(function () {
      done()
    }, 300)
  })

  it('should error when no ip or port', function () {
    try{
      new EasySock({})
    } catch (e) {
      e.message.should.eql('needs config info: ip, port')
    }
  })

  it('should log error when decode not return seq or result', function (done) {
    createServer()

    var socket = createEasySocket()

    socket.decode = function () {
      return ({hehe: '呵呵'})
    }

    socket.write({
      userid: 11,
    }, function (err, data) {
      throw new Error('should not be here')
    })

    setTimeout(function () {
      done()
    }, 500)
  })

  it('should log error when decode return wrong req', function (done) {
    createServer()

    var socket = createEasySocket()

    socket.decode = function () {
      return ({req: -1})
    }

    socket.write({
      userid: 11,
    }, function (err, data) {
      throw new Error('should not be here')
    })

    socket.on('error', function (e) {
      e.message.should.eql('decode buffer error: { req: -1 }')
    })

    setTimeout(function () {
      done()
    }, 500)
  })
})