const request = require('supertest');
const app = require('./index');

describe('SubStream Protocol API', () => {
  it('should return 200 and project information on GET /', async () => {
    const res = await request(app).get('/');
    expect(res.statusCode).toEqual(200);
    expect(res.body).toHaveProperty('project', 'SubStream Protocol');
    expect(res.body).toHaveProperty('status', 'Active');
    expect(res.body).toHaveProperty('contract', 'CAOUX2FZ65IDC4F2X7LJJ2SVF23A35CCTZB7KVVN475JCLKTTU4CEY6L');
  });
});
