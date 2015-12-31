/**
 * @fileoverview 一个方便进行socket网络操作的模块，解决socket复用，长连接、短连接，并发请求等问题
 * @author vicyao
 *
 */

'use strict';

var net = require('net');
var util = require('util')
var EventEmitter = require('events').EventEmitter;

var MAX_SEQ = 10000; // 用于标志每一个并发请求，当超过 MAX_SEQ 时，从 0 开始计数。
var TIMEOUT = 60 * 1000; // 向 socket 写数据的超时时间
var IDLE_TIMEOUT = 60 * 1000; // socket 空闲时，关闭 socket 的超时时间。

// 类似一个 enum。只能从一种状态，变成下一种，或者变成 NEW。
var STATES = {
  'NEW': 1, // 全新的实例，还未初始化 socket
  'INITING': 2, // 正在初始化 socket
  'ALIVE': 3, // socket 已经建立
  'CLOSING': 4, // 正在关闭 socket
};

//需要通过创建实例来使用
var EasySock = function (config) {
  // use `config`
  this.ip = config.ip;
  this.port = Number(config.port);

  this.keepAlive = config.keepAlive !== void 0 ? !!config.keepAlive : false;
  this.timeout = config.timeout !== void 0 ? Number(config.timeout) : TIMEOUT;
  this.idleTimeout = config.idleTimeout !== void 0 ? Number(config.idleTimeout) : IDLE_TIMEOUT;

  this.allowIdleClose = !this.keepAlive && this.idleTimeout !== 0 // 在空闲时关闭 socket
  this.allowWriteTimeout = this.timeout !== 0

  if (!this.ip || !this.port) {
    throw new Error("needs config info: ip, port");
  }
  // END

  this.restore()

  // 这三个函数需要在外部重写，具体请看 readme
  this.isReceiveComplete = null;
  this.encode = null;
  this.decode = null;

  EventEmitter.call(this);

  this.initSocket() // 初始化之后，就开始建立 socket 连接

};

util.inherits(EasySock, EventEmitter);

// 目前的会话总数
Object.defineProperty(EasySock.prototype, 'sessionCount', {
  get: function () {
    return Object.keys(this.context).length;
  }
})

// 重置所有内部状态
EasySock.prototype.restore = function () {
  //并发请求时的会话标识，会自增。
  this.seq = 0;

  //保存请求的回调函数
  this.context = {};

  // 实例唯一的socket
  this.socket = null;

  // 自身所处的状态
  this.state = STATES.NEW

  // 当连接并未建立时，缓存请求的队列
  this.taskQueue = [];

  // 记录所有 timer 的对象，关闭 socket 时需要集体释放
  this.timers = {
    connect: null, // 初始化 socket 超时
    writes: {}, // 写入超时
  };
}

/**
 * 对外的获取数据的接口方法
 * @param  {Array} data   [任意类型，会直接传给encode函数]
 * @param  {Function} callback [回调函数(err, data)]
 * @return {EasySock}    [返回自身]
 */
EasySock.prototype.write = function (data, callback) {
  var self = this;
  var args = arguments

  // 当连接未建立时，将请求缓存
  if (self.state !== STATES.ALIVE) {
    self.taskQueue.push(function (err) {
      if (err) {
        return callback(err);
      }

      self.write.apply(self, args);
    });

    self.initSocket();

    return self;
  }


  //并发情况下靠这个序列标识哪个返回是哪个请求
  var seq = self.seq % MAX_SEQ + 1;
  self.seq++


  //编码
  var buf = self.encode(data, seq);
  if (!Buffer.isBuffer(buf)) {
    return callback(new Error("encode result is not Buffer"));
  }

  // 返回超时的逻辑
  if (self.allowWriteTimeout) {
    self.timers.writes[seq] = setTimeout(function () {
      self.emit('write_timeout', seq)

      var ctx = self.context[seq]

      ctx.cb(new Error("request timeout(" + self.timeout + "ms)"))
      self.deleteTask(seq)
    }, self.timeout);
  }
  // END 返回超时的逻辑

  // 保存当前上下文，都是为了并发
  self.context[seq] = {
    seq: seq,
    cb: function (err, result) {
      clearTimeout(self.timers.writes[seq]);

      callback(err, result);
    }
  };
  // END 保存当前上下文，都是为了并发

  //真正的写socket
  self.socket.write(buf);

  return self;
};


// 删除某个已完成或出错的任务
EasySock.prototype.deleteTask = function (seq) {
  var self = this;

  delete self.context[seq];
}

/**
 * 关闭连接
 */
EasySock.prototype.close = function (msg, callback) {
  if (typeof msg == 'function') {
    callback = msg;
    msg = null;
  }

  msg = msg || 'unknown socket close reason'
  callback = callback || function () {}

  var self = this;
  var state = self.state;


  if (state === STATES.NEW) {
    // 全新的实例不需要 close
    return;
  }
  if (state === STATES.CLOSING) {
    // 防止关闭两次
    return;
  }
  self.state = STATES.CLOSING;

  if (state === STATES.INITING) {
    self.socket.destroy()
  } else if (state === STATES.ALIVE) {
    self.socket.end();
  }

  self.socket.on('close', onClose)

  function onClose() {
    self.notifyAll(new Error(msg))
    self.clearTimers()
    self.restore()
    callback()
  }
}

// 给外部所有在等待的函数一个交代
EasySock.prototype.notifyAll = function (err) {
  var self = this;

  console.error('notifyAll', err);

  // 通知所有队列中未发出的请求
  self.taskQueue.forEach(function (callback) {
    callback(err)
  })

  // 通知所有已发出，正在等待结果的请求
  for (var seq in self.context) {
    var ctx = self.context[seq];
    ctx.cb(err);
  }
}

// 清理所有 timers
EasySock.prototype.clearTimers = function () {
  var self = this;
  var timers = self.timers

  clearTimeout(timers.connect)

  for (var seq in timers.writes) {
    clearTimeout(timers.writes[seq])
  }
}

/**
 * 初始化socket方法
 */
EasySock.prototype.initSocket = function () {
  var self = this;

  if (self.state === STATES.INITING) {
    return;
  }
  self.state = STATES.INITING

  var socket = self.socket = new net.Socket({
    writable: true,
    readable: true
  });

  if (self.allowIdleClose) {
    socket.setTimeout(self.idleTimeout);
  }
  socket.setKeepAlive(self.keepAlive);

  var connectTimeout = self.timeout * 3; // 在常规的发送数据超时时间上加个倍数

  self.timers.connect = setTimeout(function () {
    self.emit('connect_timeout')

    self.close("easy_sock:TCP connect timeout(" + connectTimeout + "ms)");
  }, connectTimeout);


  socket.on('connect', function () {
    self.emit('connect')

    console.info("easy_sock connected");
    clearTimeout(self.timers.connect);

    self.state = STATES.ALIVE

    // 把积累的请求都发了
    self.taskQueue.forEach(function (task) {
      task()
    })
    self.taskQueue = []
    // END
  })

  var totalData = new Buffer('');
  socket.on('data', function (data) {
    self.emit('data', data)

    totalData = Buffer.concat([totalData, data]);

    // 网络有可能一次返回n个结果包，需要做判断，是不是很bt。。
    while (true) {
      var packageSize = self.isReceiveComplete(totalData);
      if (packageSize === 0) {
        return;
      }
      var buf = totalData.slice(0, packageSize);
      self.handleData(buf);
      totalData = totalData.slice(packageSize);
    }
  })


  socket.on('error', function (e) {
    self.emit('error', e)

    self.close('socket error:' + e);
  })

  socket.on('close', function () {
    self.emit('close')

    console.info("easy_sock closed");
  });

  if (self.allowIdleClose) {
    // 不活跃一段时间后，自动关闭 socket
    socket.on('timeout', function () {
      self.emit('idle')

      self.close('socket is inactivity for ' + self.idleTimeout + 'ms')
    })
  }

  //连接也有可能会超时阻塞
  socket.connect({
    port: self.port,
    host: self.ip
  });
}

/**
 * 处理返回数据，回调
 */
EasySock.prototype.handleData = function (buf) {
  var self = this;
  var obj = self.decode(buf);

  if (!obj || !obj.seq || !obj.result) {
    console.error("decode buffer error:", obj);
    return;
  }

  var ctx = self.context[obj.seq];
  if (!ctx) {
    //找不到上下文，可能因为服务器抽风，callback已执行，直接放弃当前数据
    console.error("Can't find context. " + obj.seq);
    return;
  }

  ctx.cb(null, obj.result);
  self.deleteTask(obj.seq)
}


exports = module.exports = EasySock

exports.STATES = STATES