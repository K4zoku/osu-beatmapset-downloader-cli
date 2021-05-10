#!/usr/bin/env node

const
  // IMPORT
  fs = require("mz/fs"),
  {join} = require("path"),
  fetch = require("node-fetch"),
  yargs = require("yargs"),
  {MultiBar} = require("cli-progress"),
  obdl = require("osu-beatmapset-downloader"),
  {OsuOfficialHost} = obdl.OsuOfficialHost,
  {login} = obdl.OsuUtil,
  // INTERNAL CONST
  defaultConfig = {
    cookies: "",
    max_threads: 3,
  },
  decors = {
    failure: "\x1b[38;5;196m■\x1b[0m",
    working: [
      "\x1b[38;5;214m■\x1b[0m",
      "\x1b[38;5;215m \x1b[0m",
      "\x1b[38;5;216m■\x1b[0m"
    ],
    success: "\x1b[38;5;46m■\x1b[0m",
  },
  barInit = {
    format: "[{decor}] {name} |{bar}| {percentFormatted}% {sizeFormatted} {speedFormatted}",
    hideCursor: true,
    fps: 30,
    barCompleteChar: "█",
    barIncompleteChar: " ",
    stopOnComplete: true,
  },
  // UTILS

  ask = (rl, question = "", muted = false) => new Promise(resolve => {
    rl.question(question, answer => resolve(answer));
    rl.stdoutMuted = muted;
  }),

  fixed = (str, length, padEnd=true, offset=0, fillChar= " ", overflow = "...") => {
    str = str.substr(offset);
    return str.length >= length ? str.length > length ? str.substr(0, length - overflow.length) + overflow : str : padEnd ? str.padEnd(length, fillChar) : str.padStart(length, fillChar);
  },

  delay = (ms=100) => new Promise(resolve => setTimeout(() => resolve(), ms)),

  readJSON = async (path, encoding="UTF-8") => fs.readFile(path, {encoding}).then(JSON.parse),

  getId = async u => {
    if (!isNaN(u)) {
      return +u;
    }
    try {
      u = new URL((u+"").toLowerCase());
    } catch (_) {
      return false;
    }
    if (u.host !== "osu.ppy.sh") return false;
    let split = u.pathname.substr(1).split("/");
    let [path, id] = split;
    if (!id) return false;
    switch (path) {
      case "b":
      case "beatmaps":
        // get redirected URL
        return fetch(u.toString()).then(res => res.url).then(getId);
      case "beatmapsets":
      case "s":
        return +id;
      default:
        return false;
    }
  },

  saveConfig = async (configFile, config) => fs.writeFile(configFile, JSON.stringify(config)).catch(err => console.error("Cannot save config.json", err)),

  download = async (odl, multiBar, bms, noVideo=false, downloadPath="./") => new Promise(async (resolve, reject) => {
    const start = Date.now();

    let size = 0,
      sizeUnit = "Mb",
      speed = "N/A", speedUnit = "Kb/s",
      percent = 0,
      i = 0, decor = decors.working[1],
      elapsed = ((Date.now() - start)/1e3).toFixed(2), elapsedUnit = "s",
      received = 0,
      name = "Connecting...";
    elapsed = (Date.now()-start)/1e3;
    elapsedUnit = "s";
    const progressBar = multiBar.create(100, 0, {
      decor, percentFormatted: "  0",
      name: fixed(name, 32),
      sizeFormatted: fixed(`${received}/${size} ${sizeUnit}`, 24, false),
      speedFormatted: fixed(`${speed} ${speedUnit}`, 16, false),
    });

    const download = odl.download(bms, noVideo);
    size = await download.size().catch(_ => 0);
    name = await download.name().catch(_ => 0) || "N/A";
    elapsed = (Date.now()-start)/1e3;
    elapsedUnit = "s";
    progressBar.update(0, {
      decor, percentFormatted: "  0",
      name: fixed(name, 32),
      sizeFormatted: fixed(`${received}/${size} ${sizeUnit}`, 24, false),
      speedFormatted: fixed(`${speed} ${speedUnit}`, 16, false),
    });
    const outFile = join(downloadPath, name);
    let offset = 0;
    let scroll = setInterval(() => progressBar.update(percent, {
      name: fixed(name, 32, true, offset++%name.length),
    }), 100);
    const stream = await download.stream()
      .catch(err => {
        clearInterval(scroll);
        elapsed = (Date.now()-start)/1e3;
        elapsedUnit = "s";
        progressBar.update(-1, {
          name: fixed(`${bms} \x1b[38;5;196mERROR ${err.status ?? err}\x1b[0m`, 47),
          decor: decors.failure,
          percentFormatted: "  0",
        });
        progressBar.stop();
        reject(err);
        return false;
      });
    stream && stream
      .on("error", err => {
        clearInterval(scroll);
        reject(err);
      })
      .on("data", data => {
        received += data.length;
        elapsed = Date.now() - start;
        speed = received / elapsed;
        percent = ~~((received / size) * 100);
        progressBar.update(percent, {
          decor: decors.working[i++ % decors.working.length],
          percentFormatted: percent.toString().padStart(3),
          sizeFormatted: fixed(`${(received/0x100000).toFixed(2)}/${(size/0x100000).toFixed(2)} ${sizeUnit}`, 24, false),
          speedFormatted: fixed(`${speed.toFixed(2)} ${speedUnit}`, 16, false),
          elapsedFormatted: fixed(`${(elapsed/1e3).toFixed(2)} ${elapsedUnit}`, 12, false)
        });
      }).on("end", () => {
        clearInterval(scroll);
        elapsed = ((Date.now()-start)/1e3).toFixed(2);
        progressBar.update(100, {
          name: fixed(name, 32),
          decor: decors.success,
          percentFormatted: 100,
          elapsedFormatted: fixed(`${elapsed} ${elapsedUnit}`, 12, false)
        });
        progressBar.stop();
      }).pipe(fs.createWriteStream(outFile))
      .on("error", err => reject(err))
      .on("finish", () => resolve(outFile));
  }),

  batch = async (odl, downloadQueue, downloadPath, noVideo, max_threads) => {
    const bars = new MultiBar(barInit);
    let freeThreads = max_threads;
    for (const beatmapset of downloadQueue) {
      const checkThreads = () => {
        if (freeThreads < 1) setTimeout(checkThreads, 100);
        else (async () => {
          freeThreads--;
          await download(odl, bars, beatmapset, noVideo, downloadPath).then(delay).catch(() => {});
          freeThreads++;
        })();
      }
      checkThreads();
    }
  };

// MAIN
(async () => {
  let argv = yargs(process.argv)
    .help().version("version", "osu-batch-download v1.0.0")
    .option("osu-session", {
      alias: "o",
      describe: "Get from cookie on https://osu.ppy.sh",
      type: "string",
    }).option("beatmapsets", {
      alias: "s",
      describe: "Provide beatmapsets in cli, separated by a comma \",\"\nUsage: \"-s <bms_1>,<bms_2>,<bms_n>\"",
      type: "string",
    }).option("lists", {
      alias: "l",
      describe: "Provide a file that contains list of beatmapsets",
      type: "string"
    }).option("no-video", {
      alias: "n",
      describe: "Download with video or not",
      type: "boolean",
    }).option("download", {
      alias: "d",
      describe: "Provide download directory\nDefault download to current working dir (cwd)",
      type: "string"
    }).option("max-threads", {
      alias: "t",
      describe: "Set max threads download in parallel",
      type: "number"
    }).argv;
  Object.defineProperty(global, "__executor", {
    value: join(argv["_"][1]+"", "../"),
    writable: false
  });
  const configFile = join(__executor, "config.json");
  let config = defaultConfig;
  if (await fs.exists(configFile)) {
    const configJson = await readJSON(configFile).catch(_ => false);
    if (configJson) {
      config.cookies = configJson.cookies;
      config.max_threads = configJson.max_threads;
    }
  }
  config.max_threads = argv["t"] || config.max_threads || defaultConfig.max_threads;
  config.cookies = argv["s"] || process.env.cookies || config.cookies || defaultConfig.cookies;
  let noVideo = argv["n"] || false;
  let downloadPath = argv["d"] || "./";

  if (!argv["b"] && !argv["l"]) {
    console.log('Please provide at least one beatmapset by option "--beatmapset <link or id>" or "--list <beatmapset list file>"');
    console.log('Use "--help" option to show more information');
    process.exitCode = 1;
    return;
  }
  let downloadQueue = [];

  argv["b"] && downloadQueue.push(...await Promise.all((argv["b"]+"").split(/, ?/).map(getId)));

  if (argv["l"]) {
    let beatmapsets = argv["l"];
    if (await fs.exists(beatmapsets)) {
      const content = await fs.readFile(beatmapsets, {encoding: "UTF-8"}).catch(_ => "");
      downloadQueue.push(...await Promise.all(content.split("\n").map(getId)));
    } else console.log(`No such file or directory "${beatmapsets}"`);
  }

  downloadQueue = Array.from(new Set(downloadQueue.filter(_ => !!_)));

  if (!downloadQueue.length) {
    console.log("Download queue is empty, exiting...");
    return;
  }

  if (!await fs.exists(downloadPath)) {
    try {
      await fs.mkdir(downloadPath);
    } catch (e) {
      console.error(e);
      process.exitCode = 1;
      console.log("Cannot create download directory!");
      return;
    }
  }

  if (!config.cookies && !argv["c"]) {
    const readline = require("readline"),
      rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });
    rl._writeToOutput = function _writeToOutput(stringToWrite) {
      rl.output.write(rl.stdoutMuted ? "" : stringToWrite);
    };
    let choose;
    doChoose: do {
      try {
        choose = parseInt("" + await ask(rl, "Please choose login method:\n 1. Login by input username and password\n 2. Enter osu_session from cookie\nYour choice: "));
        if (choose !== 1 && choose !== 2) continue;
      } catch (_) {
        continue;
      }

      switch (choose) {
        case 1:
          let username = await ask(rl, "Username: ") + "";
          let password = await ask(rl, "Password: ", true) + "";
          console.log();
          rl.close();
          let session = await login(username, password);
          config.cookies = "osu_session=" + session;
          await saveConfig(configFile, config).then(() => console.log("Saved config"));
          break doChoose;
        case 2:
          config.cookies = "osu_session=" + await ask(rl, "Open your browser, login into https://osu.ppy.sh, copy value of osu_session from cookie and paste here: ").then(_ => decodeURIComponent(_));
          rl.close();
          await saveConfig(configFile, config).then(() => console.log("Saved config"));
          break doChoose;
        default:
          break;
      }
    } while(1);
  }
  const odl = new OsuOfficialHost(config.cookies);
  await batch(odl, downloadQueue, downloadPath, noVideo, config.max_threads);
})().catch(error => console.error(error) || (process.exitCode = 1));