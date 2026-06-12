import fs from "fs"
import path from "path";
import {init} from "../bootstrap"

const envPath = path.join(process.cwd(), ".env");

// Sample credential data (test fixture only — never real credentials).
const t_user = "Tyler";
const t_pass = "Edwards";
const t_instance = "dev90755.service-now.com";

const removeEnvFile = () => {
    if (fs.existsSync(envPath)) {
        fs.unlinkSync(envPath);
    }
};

beforeEach(() => {
    removeEnvFile();
    // init() loads .env into process.env; reset so a previous test's values
    // cannot satisfy this test's assertions.
    delete process.env.SN_USER;
    delete process.env.SN_PASSWORD;
    delete process.env.SN_INSTANCE;
});

// Top-level cleanup would run at module load (before the tests); afterAll is
// what actually removes the leftover .env once the suite finishes.
afterAll(removeEnvFile);

test('Credentials undefined when file is missing', async () => {
    // Run init command (command being tested)
    await init();
    // Check "process" variables match expected results
    expect(process.env.SN_USER).toBeUndefined();
    expect(process.env.SN_PASSWORD).toBeUndefined();
    expect(process.env.SN_INSTANCE).toBeUndefined();
});
test('Credentials undefined when file is broken', async () => {
    // Create a faulty .env file; write must complete before init() runs.
    await fs.promises.writeFile(envPath,
        'SN_USR=' + t_user + ' \nSN_PASWORD' + t_pass + ' \nSN_INSTACE=' + t_instance);
    // Run init command (command being tested)
    await init();
    // Check "process" variables match expected results
    expect(process.env.SN_USER).toBeUndefined();
    expect(process.env.SN_PASSWORD).toBeUndefined();
    expect(process.env.SN_INSTANCE).toBeUndefined();
});
test('Credentials correct when file is correct', async () => {
    // Create a correct .env file; write must complete before init() runs.
    await fs.promises.writeFile(envPath,
        'SN_USER=' + t_user + ' \nSN_PASSWORD=' + t_pass + ' \nSN_INSTANCE=' + t_instance);
    // Run init command (command being tested)
    await init();
    // Check "process" variables match expected results
    expect(process.env.SN_USER).toEqual(t_user);
    expect(process.env.SN_PASSWORD).toEqual(t_pass);
    expect(process.env.SN_INSTANCE).toEqual(t_instance);
});
