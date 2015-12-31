/**
 * @fileoverview 一个方便进行socket网络操作的模块，解决socket复用，长连接、短连接，并发请求等问题
 * @author vicyao
 *
 */

'use strict';

var net = require('net');

var MAX_SEQ = 10000; // 用于标志每一个并发请求，当超过 MAX_SEQ 时，从 0 开始计数。
var TIMEOUT = 60 * 1000; // 向 socket 写数据的超时时间
var IDLE_TIMEOUT = 60 * 1000; // socket 空闲时，关闭 socket 的超时时间。

//需要通过创建实例来使用
var EasySock = exports = module.exports = function(config){

	// use `config`
	this.ip = config.ip;
	this.port = Number(config.port);

	this.keepAlive = config.keepAlive !== void 0 ? !!config.keepAlive : false;
	this.timeout = config.timeout !== void 0 ? Number(config.timeout) : TIMEOUT;
	this.idleTimeout = config.idleTimeout !== void 0 ? Number(config.idleTimeout) : IDLE_TIMEOUT;

	if (!this.ip || !this.port){
		throw new Error("needs config info: ip, port");
	}
	// END

	this.restore()

	// 这三个函数需要在外部重写，具体请看 readme
	this.isReceiveComplete = null;
	this.encode = null;
	this.decode = null;

};

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

	//全局唯一的一个socket
	this.socket = null;

	//当前是否已连接
	this.isAlive = false;

	// .close 方法的锁
	this.isClosing = false;


	// 当连接并未建立时，缓存请求的队列
	this.taskQueue = [];
}

/**
 * 对外的获取数据的接口方法
 * @param  {Array} data   [任意类型，会直接传给encode函数]
 * @param  {Function} callback [回调函数(err, data)]
 * @return {EasySock}    [返回自身]
 */
EasySock.prototype.write = function(data, callback){
	var self = this;
	var args = arguments

	// 当连接未建立时，将请求缓存
	if (!self.isAlive){
		self.taskQueue.push(function(err){
			if (err){
				return callback(err);
			}

			self.write.apply(self, args);
		});

		self.initSocket();

		return self;
	}


	//并发情况下靠这个序列标识哪个返回是哪个请求
	var seq = (++self.seq) % MAX_SEQ;

	//编码
	var buf = self.encode(data, self.seq);
	if (!Buffer.isBuffer(buf)){
		return callback(new Error("encode error, return value is not Buffer"));
	}

	// 返回超时的逻辑
	var timeoutTimer;
	if(self.timeout !== 0){
		timeoutTimer = setTimeout(function(){
			self.deleteTask(seq)

			callback(new Error("request timeout(" + self.timeout + "ms)"));
		}, self.timeout);
	}
	// END 返回超时的逻辑

	// 保存当前上下文，都是为了并发
	self.context[seq] = {
		seq : seq,
		cb : function(err, result){
			clearTimeout(timeoutTimer);

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
EasySock.prototype.close = function(msg, callback){
	callback = callback || function () {}

	var self = this;

	if (this.isClosing) {
		return;
	}

	this.isClosing = true;

	if (this.isAlive) {
		this.socket.end();
		this.socket.on('close', onClose)
	} else {
	  onClose()
	}

	function onClose() {
		self.isClosing = false;
		this.notifyAll(new Error(msg))
		this.restore()
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
	for (var seq in self.context){
		var ctx = self.context[seq];
		ctx.cb(err);
	}
}

/**
 * 初始化socket方法
 */
EasySock.prototype.initSocket = function (){
	var self = this;

	var socket = self.socket = new net.Socket({
		writable : true,
		readable : true
	});

	if (!self.keepAlive) {
		socket.setTimeout(self.idleTimeout);
	}

	socket.setKeepAlive(self.keepAlive);
	
	var connectTimeout = self.timeout * 3; // 在常规的发送数据超时时间上加个倍数
	
	var connectTimer = setTimeout(function () {
		self.close("easy_sock:TCP connect timeout(" + connectTimeout + "ms)");
	}, connectTimeout);
	
	
	socket.on('connect',function(){
		//连接成功，把等待的数据发送掉
		console.log("easy_sock connected");
		clearTimeout(connectTimer);
		self.isAlive = true;
		
		// 把积累的请求都发了
		var task;
		while(task = self.taskQueue.shift()){
			task();
		}
	})

	var totalData = new Buffer('');
	socket.on('data', function(data) {
		if (!data || !Buffer.isBuffer(data) || data.length <= 0 ){
			socket.emit('error', new Error('receive error, illegal data'))
			return;
		}

		totalData = Buffer.concat([totalData, data]);

		// 网络有可能一次返回n个结果包，需要做判断，是不是很bt。。
		while(true){
			var packageSize = self.isReceiveComplete(totalData);
			if (packageSize === 0) {
				return;
			}
			var buf = totalData.slice(0, packageSize);
			self.handleData(buf);
			totalData = totalData.slice(packageSize);
		}
	})


	socket.on('error', function(e){
		self.close('socket error:' + e);
	})


	socket.on('close', function () {
		console.log("easy_sock closed");
	});

	if (!self.keepAlive) {
		// 不活跃一段时间后，自动关闭 socket
		socket.on('timeout', function () {
			self.close('socket is inactivity for ' + self.idleTimeout + 'ms')
		})
	}
		
	//连接也有可能会超时阻塞
	socket.connect({
		port : self.config.port,
		host : self.config.ip
	});
}

/**
 * 处理返回数据，回调
 */
EasySock.prototype.handleData = function (self, buf){
	var self = this;
	
	var obj = self.decode(buf);

	if (!obj) {
		console.error("decode buffer error:", obj);
		return;
	}
	
	var ctx = self.context[obj.seq];
	if (!ctx){
		//找不到上下文，可能是因为超时，callback已执行，直接放弃当前数据
		console.error("Can't find context. " + obj.seq);
		return;
	}

	self.deleteTask(obj.seq)

	ctx.cb(null, obj.result);
}