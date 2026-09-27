wa-bot/
├── src/
│   ├── index.js              # Entry point
│   ├── connection.js         # ⚡ Bot connection (NEVER touch to add commands)
│   ├── commands.js           # ✅ ALL COMMANDS IN THIS ONE FILE
│   ├── handler.js            # Router (loads from commands.js)
│   ├── config.js
│   ├── lib/
│   │   ├── database.js
│   │   └── utils.js
│   ├── events/
│   │   └── groupEvents.js
│   ├── auth/creds/           # auto-generated session
│   └── dashboard/
│       ├── server.js
│       ├── routes.js
│       └── views/
│           ├── login.ejs
│           └── dashboard.ejs
├── .env
└── package.json