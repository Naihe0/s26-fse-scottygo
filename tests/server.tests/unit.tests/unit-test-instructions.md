# Unit Test Organization

## Unit Test Organization

- **Directory**: All unit tests are located in the following directory: _tests/server.tests/unit.tests/_
- **Suite Coverage**: In principle, there should be 1 unit test suite for each business logic file and utility file (e.g., one suite for each model and each utility/helper module).
- **Suite Cohesion**: In principle, each test suite should be cohesive, with 1 unit test suite covering an entire implementation file (e.g., ‘performFunction.unit.test.ts’ which tests a hypothetical implementation file ‘performFunction.ts’).
- **File Naming Conventions**: Unit test files should consist of the **name**, then be followed by ‘.[**unit.test.ts**](http://unit.test.ts)’, such as ‘[register.unit.test.ts](http://register.unit.test.ts)’ for a test on registration. Names should be the same as that of either the use case (described in `docs/FEATURES.md`) or the implementation file being tested (e.g., ‘performFunction.unit.test.ts’ which tests a hypothetical implementation file ‘performFunction.ts’).

# Unit Test Suite Structure

## Unit Test Suite Structure

```ts
// import dependancies here

// Mock external services (e.g. MockResponse, requests, database)

type MockResponse = Partial<Response> & {
  status: jest.Mock;
  json: jest.Mock;
};

const createMockResponse = (): MockResponse => {
  const res: MockResponse = {
    status: jest.fn(),
    json: jest.fn()
  };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
};

// Shared test data
const adminAccount: IUserAccount = {
  _id: 'admin-id-001',
  credentials: { username: 'testadmin', password: 'hashed-pw' },
  email: 'testadmin@andrew.cmu.edu',
  agreed: true,
  status: 'Active',
  privilegeLevel: 'Administrator'
};

const memberAccount: IUserAccount = {
  _id: 'member-id-001',
  credentials: { username: 'testmember', password: 'hashed-pw' },
  email: 'testmember@andrew.cmu.edu',
  agreed: true,
  status: 'Active',
  privilegeLevel: 'Member'
};

// Test descriptions should:
//   - State the expected behavior or outcome, not "test that..." or "check if..."
//   - Use format: "<subject> <expected outcome> [when <condition>]"
//   - Good:  'sole administrator cannot be demoted'
//   - Bad:   'test that demoting the sole admin throws an error'

describe('<Use Case Name> unit tests', () => {
  beforeAll(() => {
    /* one-time setup: DB connection, shared resources */
  });
  afterAll(() => {
    /* one-time teardown: close connections */
  });
  beforeEach(() => {
    /* per-test reset: fresh fixture for independence */
  });

  describe('Business rule name', () => {
    test('description of expected behavior', async () => {
      // Arrange: mock DB
      DAC.db = createMockDb({
        someMethod: jest.fn().mockResolvedValue(someData)
      });

      // Act + Assert
      const result = await User.someMethod('arg');
      expect(result.field).toBe('expectedValue');
    });

    test('(negative) description of rejected behavior', async () => {
      DAC.db = createMockDb({
        someMethod: jest.fn().mockResolvedValue(null)
      });

      await expect(User.someMethod('arg')).rejects.toMatchObject({
        name: 'ErrorName'
      });
    });
  });

  // Controller-level tests: mock User model, test authorization

  describe('Authorization rule name', () => {
    // const controller = new AccountController('/account');

    test('permitted action succeeds', async () => {
      // jest.spyOn(User,  'getUserAccountById').mockResolvedValue(adminAccount);
      // jest.spyOn(User, 'doThing').mockResolvedValue(updatedAccount);
      // const req = createAuthenticatedRequest(adminAccount, { username: 'target' }, { field: 'value' });
      // const res = createMockResponse();
      // await controller.doThing(req, res as Response);
      // expect(res.status).toHaveBeenCalledWith(200);
    });

    test('(negative) forbidden action is rejected', async () => {
      // jest.spyOn(User, 'getUserAccountById').mockResolvedValue(adminAccount);
      // const req = createAuthenticatedRequest(adminAccount, { username: 'target' }, { field: 'value' });
      // const res = createMockResponse();
      // await controller.forbiddenMethod(req, res as Response);
      // expect(res.status).toHaveBeenCalledWith(403);
    });
  });
});
```

# Unit Test Patterns

## Unit Test Patterns Positive Test Pattern

Guidelines for writing positive (happy-path) unit tests.  
Rules

1\. For valid targets shared by multiple tests, define the instance \*\*outside\*\* the test function.  
2\. When using the DAC, only connect to the \*\*development\*\* MongoDB database. Never modify entries in the production database.  
3\. Each test should verify \*\*one\*\* expected behavior with a clear, descriptive name.  
4\. Use the \*\*Arrange → Act → Assert\*\* structure.  
5.For naming conventions, the test name should be descriptive, state what behavior is being tested and what is expected of that behavior

Generic Template

// Arrange (shared fixture)  
const validInput \= { /\* valid properties for the unit under test \*/ };

describe('UnitUnderTest', () \=\> {

// Test 1: validation / business rule  
test('It should be possible to accept valid input', () \=\> {  
// Act  
const result \= UnitUnderTest.validate(validInput);

// Assert  
expect(result).toBe(true);  
});

// Test 2: persistence  
test('It should persist a new record', async () \=\> {  
// Arrange  
DAC.db \= new DB();

// Act  
const saved \= await UnitUnderTest.create(validInput);

// Assert  
expect(saved).toBeDefined();  
expect(saved.id).toBeTruthy();  
});

// Test 3: retrieval  
test('It should be possible to retrieve an existing record by id', async () \=\> {  
// Arrange  
const created \= await UnitUnderTest.create(validInput);

// Act  
const found \= await UnitUnderTest.findById(created.id);

// Assert  
expect(found).toEqual(created);  
});  
});

# Unit Test Principles

## Unit Test Principles

- **Simplicity:** Refactor mixed logic into self-contained functions before testing. Simplify complex fixture setups. Take small steps by testing only a small piece of logic at a time.
- **Understandability (No Magic Numbers):** Replace magic numbers with explicit, named constants (e.g., `const MIN_LENGTH = 8;`).
- **Descriptive Test Purpose:** Name tests to explicitly state the purpose and expected result (e.g., use 'check saving works' instead of generic names like 'test 1'). Use the most specific Jest matchers available, especially when evaluating collections.
- **Single Purpose (No Conditionals):** Avoid conditionals in tests. Split tests that have conditional logic into multiple tests. .

```ts
// Bad – two behaviors
test('username', () => {
  dothis();
  expect(user.name).toBe('alice');
  dothat(); // second action
  expect(user.role).toBe('admin');
});

// Good – one behavior per test
test('default role is Member', () => {
  dothis();
  expect(user.name).toBe('alice');
  expect(user.role).toBe('Member');
});
```

- **Essentiality (No Redundant Assertions):** Remove unnecessary assertions that make tests brittle. For example, do not assert that an object `not.toBe(null)` immediately before asserting a specific property value on that exact same object.

```ts
// Bad – redundant null check
expect(account).not.toBeNull();
expect(account.status).toBe('Active'); // would already throw if null

// Good – the meaningful assertion alone is sufficient
expect(account.status).toBe('Active');
```

- **Maintainability (No Duplication):** Treat test code like production code and actively refactor it. Move shared setup code or fixtures into `beforeEach` or `beforeAll` blocks to eliminate duplication.

```ts
// Bad – repeated setup in every test
test('test A', () => {
  const db = new MongoDB(url); /* … */
});
test('test B', () => {
  const db = new MongoDB(url); /* … */
});

// Good – shared setup
beforeAll(() => {
  db = new MongoDB(url);
});
```

- **Determinism (No Lottery Tests):** Isolate and remove sources of nondeterminism. Use mocks to control external dependencies so tests do not fail randomly simply because an external service is unavailable.

```ts
// Bad – depends on live API
const routes = await fetch('https://truetime.portauthority.org/...');

// Good – mock the external dependency
jest.mock('../services/truetime.service');
```

- **Independence:** Ensure tests can run in any order while yielding the exact same results. Do not let tests depend on state mutations caused by previous tests. Explicitly re-initialize state variables for each test to maintain strict isolation.
- **Failability:** Never write tests without assertions. Make sure unfinished tests intentionally throw explicit errors. Ensure negative tests can demonstrably fail when the code is broken rather than always passing.

```ts
// Bad – will always pass, tests nothing
test('placeholder', () => {});

// Good – unfinished test fails explicitly
test('todo: validate email format', () => {
  throw new Error('Not implemented');
});
```

- **Comprehensiveness:** Write explicit tests covering both happy and sad paths. Ensure you specifically test boundary cases and corner cases.
  1. **Behavior First:** Prioritize black-box testing over white-box testing. Focus on verifying the outward behavior, not the underlying implementation details. Do not treat 100% test coverage as the primary goal.
- **Speed:** Rethink and optimize sluggish tests to guarantee fast feedback. Use test doubles (mocks) to bypass slow or computationally expensive resources.
