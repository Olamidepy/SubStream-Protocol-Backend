const express = require('express');
const app = express();
const port = 3000;

app.get('/', (req, res) => {
  res.json({ 
    project: 'SubStream Protocol', 
    status: 'Active', 
    contract: 'CAOUX2FZ65IDC4F2X7LJJ2SVF23A35CCTZB7KVVN475JCLKTTU4CEY6L' 
  });
});
if (require.main === module) {
  app.listen(port, () => console.log('SubStream API running'));
}

module.exports = app;
