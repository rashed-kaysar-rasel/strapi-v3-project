module.exports = ({ env }) => ({
  defaultConnection: 'default',
  connections: {
    default: {
      connector: 'mongoose',
      settings: {
        client: 'mongo',
        uri: env('DATABASE_URI', 'mongodb://localhost:27017/Library'),
        database: env('DATABASE_NAME', 'Library'),
        srv: false,
      },
      options: {
        ssl: false,
      },
    },
  },
});