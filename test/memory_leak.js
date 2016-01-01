var memwatch = require('memwatch-next')
var EasySock = require('..')

console.info = console.error = function () {}



var arr = [];

memwatch.gc();
var hd = new memwatch.HeapDiff();

for (var i = 0; i < 10000; i++) {
  var socket = new EasySock({
    ip: '127.0.0.1',
    port: '3000'
  })

  socket.write({
    haha: 11
  }, function (err, data) {

  })

  arr.push(socket)
}

arr.forEach(function (sock)  {
  sock.close()
})

arr = null


setTimeout(function () {
  memwatch.gc();
  var hde = hd.end();

  console.log(JSON.stringify(hde, null, 2));
}, 2000)
