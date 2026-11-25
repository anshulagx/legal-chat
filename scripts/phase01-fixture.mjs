import mongoose from 'mongoose';
import '../server/dist/index.js';

// The test runner alone can disconnect this process's database connection.
process.on('message', async message => {
  if (message === 'disconnect-database') {
    await mongoose.disconnect();
    process.send?.('database-disconnected');
  }
});
