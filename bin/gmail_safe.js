#!/usr/local/bin/node


var gmi = require('gmail').GMailInterface,
  ProgressBar = require('progress2');
  spawn = require('child_process').spawn,
  redis_client = require('redis'),
  path = require('path'),
  EE = require('events').EventEmitter,
  fs = require('node-fs');

var opts = require('nomnom')
  .option('directory',{
    flag: false,
    help: "Store results in <directory>, which will be created if need be.",
    position: 0,
    required: true,
    type: "string"
  })
  .option('username',{
    flag: false,
    abbr: 'u',
    help: "Username, an email ending in @gmail.com",
    required: true,
    type: "string"
  })
  .option('password',{
    flag: false,
    abbr: 'p',
    help: "Password, or an application-specific password.",
    required: true,
    type: "string"
  })
  .parse();


var mainloop = new EE();
// Script-level 'globals'. I don't like these, but they seem idiomatic.
var db = null;
var redis = null;
var work_path = null;
var gm = null;



// Hook the process exit patterns to mainloop
process.on('exit', function() {
  mainloop.emit('exit');
});
process.on('uncaughtException', function(err) {
  mainloop.emit('exit',err);
});



// For some reason, possibly an error, close it all down.
// It is safe to call process.exit() here, although note
// that this code can be run by someone else calling process.exit()
// - the magic of Node somehow handles this appropriately.
//
// Do NOT call this event directly for a normal shutdown. Instead,
// call 'close'.
//
// This handler MUST block, and MUST NOT return. IE, it cannot
// be asynchronous. (For one, there might well not be a next tick.)
mainloop.once('exit',function(err) {
  // Cleanup
  console.log("Closing connections...");
  redis.kill(); // sends SIGTERM
  db.end(); // Abruptly ends client, even mid-stream. Totally OK, because
            // the server just died (maybe).

  // Quit
  if (err) {
    console.log("Fatal Error:");
    console.log(err);
    process.exit(1);
  } else {
    console.log("Finished (OK).");
    process.exit(0);
  }
});

// Create a helper to get to die on errors for callbacks.
var die = function(err) {
  if(err) {
    mainloop.emit('exit',err);
  }
}


// Main entrant
mainloop.once('main',function() {
  configure_local_env(opts);
  // We now have the 'db' redis client, 'work_path', 'gm', and others.

  // Connect to the gmail server
  console.log("Connecting to Google Mail...");
  gm.connect(opts.username,opts.password,function() {
    console.log("Connected.");
    mainloop.emit('imap_connect');
  });
});


// imap_connect - when the 'gm' interface connects to the server
mainloop.on('imap_connect', function() {
  var fetcher = gm.get(); // Fetch ALL the mails! (apologies to Ms. Allie)
  var bar;

  fetcher.once('end',function(){
    console.log();
    mainloop.emit('close');
  });
  fetcher.on('fetching',function(ids) {
    console.log("Fetching",ids.length,"emails (this may take some time)...");
    console.log();
    bar = new ProgressBar('[:bar] :percent (:elapsed/:finish) :eta', {
      total: ids.length,
      width: 40,
    });
  });
  fetcher.on('fetched',function(msg){
    bar.tick(1);
    var emlfile = path.join(opts.directory,msg.id + ".eml");
    fs.writeFile(emlfile,msg.eml,"utf8",die);

    var storeobj = {
      "id": msg.id,
      "thread": msg.thread,
      "date": msg.date,
      "labels": msg.labels
      // Skip msg.eml to avoid storing the entire email (for now anyway)
    };

    // I would like to use db.HMSET, but it is being very weird.
    // This needs further investigating. For now, just JSONify it.
    db.set(msg.id,JSON.stringify(storeobj),die);
  });
});

// A 'gentle' start to stopping the program.
// Success flows through this event.
mainloop.on('close',function() {
  db.quit();
  gm.logout(die);
  mainloop.emit('exit');
})



// HELPER FUNCTIONS


// configure_local_env - make sure that some consistent environment for
// execution exists, is writable, and open a redis database server and client.
var configure_local_env = function(opts) {
  work_path = path.resolve(opts.directory); // Absolute path resolution.
  maybe_create_path(work_path);
  var meta_path = path.join(work_path,"meta/");
  maybe_create_path(meta_path);
  var conf_path = path.join(meta_path,"store.conf");

  var bindaddr = "127.0.0.1";
  var port = 36127; // Chosen totally at random. Should become an option.

  if (!path.existsSync(conf_path)) {
    // This is a very lazy config representation - the config file will
    // be generated simply by writing one 'option' per line, in the format
    // 'key value' - that is the key, a space, and the value.
    // Do with it as you will. Suggestion: use only strings. YMMV otherwise.
    var config = {
      "daemonize":"no",
      "pidfile": "/dev/null", // Won't be used, but I just want to be sure.
      "bind": bindaddr,
      "port": port.toString(),
      "timeout":"20", // We want it to fail fast, rather than linger.
      "dbfilename": "store.redis",
      "dir": meta_path,
      "loglevel": "notice",
      "logfile": "stdout",
      "databases": "1",
      "maxclients": "1",
      //"maxmemory": "512MB", // hasn't been working well for me.
      "save 15": "1",
    }

    // In Python (my nominal language), I would do this using
    // a nested list comprehension. There is probably a similar
    // efficient way in JavaScript, but I do not know it (yet).
    var config_contents = ""
    for (var key in config) {
      config_contents += key + " " + config[key] + "\n";
    }

    fs.writeFileSync(conf_path,config_contents,"utf8");
  }

  // Start up the redis node
  redis = spawn("redis-server",[conf_path]);
  redis.once('exit',function(code,signal) {
    // Once is important here so that this only triggers the error message
    // once, and only if there was an error.
    if (isNull(code) || code != 0 || isNull(signal) || signal != 'SIGTERM') {
      // Something bad happened.
      die("Unknown errror, database died. <Code Signal>:"+code+" "+signal);
    }
  });

  // Start up a redis client
  console.log("Starting redis cache...");
  db = redis_client.createClient(36127,"127.0.0.1");

  // Create a blank gmail object
  gm = new gmi();
}

// Create the path even if it or parts of it exist or don't exist yet,
// Or maybe don't create it if it already exists completely.
// Also, do this recursively and do it with mode 0770 (user-group r/w/e)
var maybe_create_path = function (path) {
  // The majority of the work here uses 'node-fs''s hooks to mkdir*
  try {
    fs.mkdirSync(path,true,0770);
  } catch (e) {
    // Do nothing - the dir already existed.
  }
}



// And finally, cause the main entrant. No code below this, please.
mainloop.emit('main');