'use strict';

/**
 * @fileoverview 封装UDP请求的相关逻辑，只适用于标准应答试请求，即一个发包一个回包。
 * 重要提示：跟TCP不同，对于UDP请求，不能用一个socket做并发请求。原因是nodejs进程有可能来不及处理所有的收包响应，导致下一个udp响应包替换前一个包，造成丢包，从而造成回调函数没有调用。
 * 所以，每次请求都重新创建一个socket来发包收包。
 * 注意该代码只能在node 4.2以上版本执行，node 0.1版本的udp存在bug。
 * 在ptlogin下测试，每1000个并发请求耗时190ms
 * @author vicyao
 */
var debug = require("debug")('easysock');
var dgram = require("dgram");
var EasySockError = require('./errors').EasySockError;

var MAX_SEQ = 100000; // 用于标志每一个并发请求，当超过 MAX_SEQ 时，从 0 开始计数。

//需要通过创建实例来使用
var Easyudp = module.exports = function (conf) {
	conf = conf || {};

	//并发请求时的会话标识，实际上这里并不需要seq，只是为了防止回调混淆
	this.seq = 0;

	this.ip      = conf.ip !== void 0       ? conf.ip : "";
	this.port    = conf.port !== void 0     ? Number(conf.port) : 0;
	this.timeout = conf.timeout !== void 0  ? Number(conf.timeout) : 5000;

	//输入(object,seq),输出buffer
	this.encode = null;

	//输入buffer，输出object
	this.decode = null;
};

/**
 * 对外的发送数据的接口方法，其实用send更合适，但为了跟easysock统一，兼容下write
 * @param  {[Array]} data   [任意类型，会直接传给encode函数]
 * @param  {[Function]} callback [回调函数(err, data)]
 * @return {[void]}        [void]
 */
Easyudp.prototype.write = Easyudp.prototype.send = function (data, callback) {

	var self = this;
	this.seq = (this.seq + 1) % MAX_SEQ;
	var cur_seq = this.seq;

	var buf = this.encode(data, cur_seq);

	if (!Buffer.isBuffer(buf)) {
		callback(new EasySockError("encode error"));
		return;
	}

	//每次都新建一个socket，不复用
	var socket = dgram.createSocket("udp4");

	socket.bind({
		port: 0,
		exclusive: true	//当exclusive为true时不会复用socket句柄，否则会导致回调函数混乱。但在0.1中，即使将exclusive设置为true，nodejs还是会重复分配端口，这是个坑
	}, function () {
		//注意，虽然这个bind有回调，但实际上不需要等bind的回调执行，就可以开始发送数据了
		//var address = socket.address();
		//console.log("bind success. port=" + address.port);		
	});

	//超时处理
	var timer = null;
	if (this.timeout) {
		timer = setTimeout(function () {
			if (socket) {
				try {
					socket.close();
				} catch (e) {
					//nodejs 0.1版本出现过
					debug("close error:" + e);
				}
			}
			callback(new EasySockError("easyudp: Request timeout(" + self.timeout + "ms)!"));

		}, self.timeout);
	}

	//接收回包
	socket.on("message", function (msg, rinfo) {

		//如果这里有异常，直接往外抛出
		var result = self.decode(msg);
		if (result && result.seq != null) {

			if (timer) {
				//清除超时的timer
				clearTimeout(timer);
			}

			//回调正确性检测
			if (cur_seq != result.seq) {
				//发送的请求跟回调不匹配，多个socket并发的时候互相混淆，这个bug在nodejs 0.1版本出现过，4.2之后应该不会了
				callback(new EasySockError("easyudp: 发送的请求跟回调不匹配. send seq=" + cur_seq + ", received seq=" + result.seq));
			} else {
				callback(null, result);
			}
		} else {
			//result不正确
			callback(new EasySockError("decode error"));
		}

		//完成后即销毁socket
		socket.close();
	});

	socket.on("error", function (err) {
		if (timer) {
			//清除超时的timer
			clearTimeout(timer);
		}
		//如果数据已正常反馈，再发生错误，callback会被调用2次，但实际上这种情况应该不会发生。
		callback(err);
	});

	socket.on("close", function (err) {
		socket = null;
	});

	//真正发送请求
	socket.send(buf, 0, buf.length, this.port, this.ip, function (err, bytes) {
		if (err) {
			//按照文档，这里只有可能出现DNS解析错误，通过ip发送应该不会报错
			callback(err);
		}
	});
};