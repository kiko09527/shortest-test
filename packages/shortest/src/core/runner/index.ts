import { pathToFileURL } from "url";
import Anthropic from "@anthropic-ai/sdk";
import { glob } from "glob";
import { APIRequest, BrowserContext } from "playwright";
import * as playwright from "playwright";
import { request, APIRequestContext } from "playwright";
import { z } from "zod";
import { AIClient } from "@/ai/client";
import { BrowserTool } from "@/browser/core/browser-tool";
import { BrowserManager } from "@/browser/manager";
import { BaseCache } from "@/cache/cache";
import { TestCompiler } from "@/core/compiler";
import { TestReporter } from "@/core/runner/test-reporter";
import { initializeConfig, getConfig } from "@/index";
import { getLogger, Log } from "@/log/index";
import {
  TestFunction,
  TestContext,
  ShortestConfig,
  BrowserActionEnum,
} from "@/types";
import { CacheEntry } from "@/types/cache";
import { hashData } from "@/utils/crypto";
import { getErrorDetails } from "@/utils/errors";

export const TokenMetricsSchema = z.object({
  input: z.number().default(0),
  output: z.number().default(0),
});
export type TokenMetrics = z.infer<typeof TokenMetricsSchema>;

const STATUSES = ["pending", "running", "passed", "failed"] as const;
export type TestStatus = (typeof STATUSES)[number];

export const TestResultSchema = z.object({
  test: z.any() as z.ZodType<TestFunction>,
  status: z.enum(STATUSES),
  reason: z.string(),
  tokenUsage: TokenMetricsSchema.default({ input: 0, output: 0 }),
});
export type TestResult = z.infer<typeof TestResultSchema>;

export const FileResultSchema = z.object({
  filePath: z.string(),
  status: z.enum(STATUSES),
  reason: z.string(),
});
export type FileResult = z.infer<typeof FileResultSchema>;

export class TestRunner {
  private config!: ShortestConfig;
  private cwd: string;
  private exitOnSuccess: boolean;
  private forceHeadless: boolean;
  private targetUrl: string | undefined;
  private compiler: TestCompiler;
  private browserManager!: BrowserManager;
  private reporter: TestReporter;
  private noCache: boolean;
  private testContext: TestContext | null = null;
  private cache: BaseCache<CacheEntry>;
  private log: Log;

  constructor(
    cwd: string,
    exitOnSuccess = true,
    forceHeadless = false,
    targetUrl?: string,
    noCache = false,
  ) {
    this.cwd = cwd;
    this.exitOnSuccess = exitOnSuccess;
    this.forceHeadless = forceHeadless;
    this.targetUrl = targetUrl;
    this.noCache = noCache;
    this.compiler = new TestCompiler();
    this.reporter = new TestReporter();
    this.log = getLogger();
    this.cache = new BaseCache();
  }

  async initialize() {
    await initializeConfig();
    this.config = getConfig();

    // Override with CLI options
    if (this.forceHeadless) {
      this.config = {
        ...this.config,
        headless: true,
      };
    }

    if (this.targetUrl) {
      this.config = {
        ...this.config,
        baseUrl: this.targetUrl,
      };
    }

    this.browserManager = new BrowserManager(this.config);
  }

  private async findTestFiles(pattern?: string): Promise<string[]> {
    this.log.trace("Finding test files", { pattern });
    const testPattern = pattern || this.config.testPattern || "**/*.test.ts";

    const files = await glob(testPattern, {
      cwd: this.cwd,
      absolute: true,
    });

    if (files.length === 0) {
      this.reporter.error(
        "Test Discovery",
        `No test files found matching: ${testPattern}`,
      );
      this.log.error("No test files found matching", {
        pattern: testPattern,
      });
      process.exit(1);
    }

    return files;
  }

  private async createTestContext(
    context: BrowserContext,
  ): Promise<TestContext> {
    if (!this.testContext) {
      // Create a properly typed playwright object
      const playwrightObj = {
        ...playwright,
        request: {
          ...request,
          newContext: async (options?: {
            extraHTTPHeaders?: Record<string, string>;
          }) => {
            const requestContext = await request.newContext({
              baseURL: this.config.baseUrl,
              ...options,
            });
            return requestContext;
          },
        },
      } as typeof playwright & {
        request: APIRequest & {
          newContext: (options?: {
            extraHTTPHeaders?: Record<string, string>;
          }) => Promise<APIRequestContext>;
        };
      };

      this.testContext = {
        page: context.pages()[0],
        browser: this.browserManager.getBrowser()!,
        playwright: playwrightObj,
      };
    }
    return this.testContext;
  }

  private async executeTest(
    test: TestFunction,
    context: BrowserContext,
    config: { noCache: boolean } = { noCache: false },
  ): Promise<TestResult> {
    // If it's direct execution, skip AI
    if (test.directExecution) {
      try {
        const testContext = await this.createTestContext(context);
        await test.fn?.(testContext);
        return {
          test: test,
          status: "passed",
          reason: "Direct execution successful",
          tokenUsage: { input: 0, output: 0 },
        };
      } catch (error) {
        return {
          test: test,
          status: "failed",
          reason:
            error instanceof Error ? error.message : "Direct execution failed",
          tokenUsage: { input: 0, output: 0 },
        };
      }
    }

    // Use the shared context
    const testContext = await this.createTestContext(context);
    const browserTool = new BrowserTool(testContext.page, this.browserManager, {
      width: 1920,
      height: 1080,
      testContext: {
        ...testContext,
        currentTest: test,
        currentStepIndex: 0,
      },
    });

    // this may never happen as the config is initialized before this code is executed
    if (!this.config.anthropicKey) {
      return {
        test: test,
        status: "failed",
        reason: "ANTHROPIC_KEY is not set",
        tokenUsage: { input: 0, output: 0 },
      };
    }

    const aiClient = new AIClient({
      apiKey: this.config.anthropicKey,
      model: "claude-3-5-sonnet-20241022",
      maxMessages: 10,
    });

    // First get page state
    const initialState = await browserTool.execute({
      action: "screenshot",
    });

    // Build prompt with initial state and screenshot
    const prompt = [
      `Test: "${test.name}"`,
      test.payload ? `Context: ${JSON.stringify(test.payload)}` : "",
      `Callback function: ${test.fn ? " [HAS_CALLBACK]" : " [NO_CALLBACK]"}`,

      // Add expectations if they exist
      ...(test.expectations?.length
        ? [
            "\nExpect:",
            ...test.expectations.map(
              (exp, i) =>
                `${i + 1}. ${exp.description}${
                  exp.fn ? " [HAS_CALLBACK]" : "[NO_CALLBACK]"
                }`,
            ),
          ]
        : ["\nExpect:", `1. "${test.name}" expected to be successful`]),

      "\nCurrent Page State:",
      `URL: ${initialState.metadata?.window_info?.url || "unknown"}`,
      `Title: ${initialState.metadata?.window_info?.title || "unknown"}`,
    ]
      .filter(Boolean)
      .join("\n");

    // check if CLI option is not specified
    if (!this.noCache && !config.noCache) {
      // if test hasn't changed and is already in cache, replay steps from cache
      if (await this.cache.get(test)) {
        try {
          const result = await this.runCachedTest(test, browserTool);

          if (test.afterFn) {
            try {
              await test.afterFn(testContext);
            } catch (error) {
              return {
                test: test,
                status: "failed",
                reason:
                  result?.status === "failed"
                    ? `AI: ${result.reason}, After: ${
                        error instanceof Error ? error.message : String(error)
                      }`
                    : error instanceof Error
                      ? error.message
                      : String(error),
                tokenUsage: { input: 0, output: 0 },
              };
            }
          }
          return { ...result, tokenUsage: { input: 0, output: 0 } };
        } catch {
          // delete stale cached test entry
          await this.cache.delete(test);
          // reset window state
          const page = browserTool.getPage();
          await page.goto(initialState.metadata?.window_info?.url!);
          await this.executeTest(test, context, {
            noCache: true,
          });
        }
      }
    }

    // Execute before function if present
    if (test.beforeFn) {
      try {
        await test.beforeFn(testContext);
      } catch (error) {
        return {
          test: test,
          status: "failed",
          reason: error instanceof Error ? error.message : String(error),
          tokenUsage: { input: 0, output: 0 },
        };
      }
    }

    // Execute test with enhanced prompt
    this.log.setGroup("🤖");
    const result = await aiClient.processAction(prompt, browserTool);
    this.log.resetGroup();
    if (!result) {
      throw new Error("AI processing failed: no result returned");
    }

    // Parse AI result first
    const finalMessage = result.finalResponse.content.find(
      (block: any) =>
        block.type === "text" &&
        (block as Anthropic.Beta.Messages.BetaTextBlock).text.includes(
          '"status":',
        ),
    );

    if (!finalMessage || finalMessage.type !== "text") {
      throw new Error("No test result found in AI response");
    }

    const jsonMatch = (
      finalMessage as Anthropic.Beta.Messages.BetaTextBlock
    ).text.match(/{[\s\S]*}/);
    if (!jsonMatch) {
      throw new Error("Invalid test result format");
    }

    const aiResult = JSON.parse(jsonMatch[0]) as TestResult;

    // Execute after function if present
    if (test.afterFn) {
      try {
        await test.afterFn(testContext);
      } catch (error) {
        return {
          test: test,
          status: "failed",
          reason:
            aiResult.status === "failed"
              ? `AI: ${aiResult.reason}, After: ${
                  error instanceof Error ? error.message : String(error)
                }`
              : error instanceof Error
                ? error.message
                : String(error),
          tokenUsage: result.tokenUsage,
        };
      }
    }

    if (aiResult.status === "passed") {
      // batch set new chache if test is successful
      await this.cache.set(test, result.pendingCache);
    }
    return { ...aiResult, tokenUsage: result.tokenUsage };
  }

  private async executeTestFile(file: string) {
    try {
      const registry = (global as any).__shortest__.registry;

      registry.tests.clear();
      registry.currentFileTests = [];

      const filePathWithoutCwd = file.replace(this.cwd + "/", "");
      const compiledPath = await this.compiler.compileFile(file);
      this.log.trace("Importing compiled file", {
        compiledPath,
      });
      await import(pathToFileURL(compiledPath).href);

      let context;
      try {
        this.log.trace("Launching browser");
        context = await this.browserManager.launch();
      } catch (error) {
        this.log.error("Browser initialization failed", getErrorDetails(error));
        return;
      }
      this.log.trace("Creating test context");
      const testContext = await this.createTestContext(context);

      try {
        // Execute beforeAll hooks with shared context
        for (const hook of registry.beforeAllFns) {
          await hook(testContext);
        }

        this.reporter.onFileStart(
          filePathWithoutCwd,
          registry.currentFileTests.length,
        );

        // Execute tests in order they were defined
        this.log.info(`Running ${registry.currentFileTests.length} test(s)`);
        for (const test of registry.currentFileTests) {
          // Execute beforeEach hooks with shared context
          for (const hook of registry.beforeEachFns) {
            await hook(testContext);
          }

          this.reporter.onTestStart(test);
          const testResult = await this.executeTest(test, context);
          this.reporter.onTestEnd(testResult);

          // Execute afterEach hooks with shared context
          for (const hook of registry.afterEachFns) {
            await hook(testContext);
          }
        }

        // Execute afterAll hooks with shared context
        for (const hook of registry.afterAllFns) {
          await hook(testContext);
        }
      } finally {
        await this.browserManager.close();
        this.testContext = null; // Reset the context
        registry.beforeAllFns = [];
        registry.afterAllFns = [];
        registry.beforeEachFns = [];
        registry.afterEachFns = [];
        const fileResult: FileResult = {
          filePath: file,
          status: "passed",
          reason: "",
        };
        this.reporter.onFileEnd(fileResult);
      }
    } catch (error) {
      this.testContext = null; // Reset on error
      if (error instanceof Error) {
        const fileResult: FileResult = {
          filePath: file,
          status: "failed",
          reason: error.message,
        };

        this.reporter.onFileEnd(fileResult);
      }
    }
  }

  async runTests(pattern?: string) {
    await this.initialize();
    const files = await this.findTestFiles(pattern);

    if (files.length === 0) {
      this.reporter.error(
        "Test Discovery",
        `No test files found matching the pattern: ${pattern || this.config.testPattern}`,
      );
      process.exit(1);
    }

    this.reporter.onRunStart(files.length);
    for (const file of files) {
      await this.executeTestFile(file);
    }

    this.reporter.onRunEnd();

    if (this.exitOnSuccess && this.reporter.allTestsPassed()) {
      process.exit(0);
    } else {
      process.exit(1);
    }
  }

  private async runCachedTest(
    test: TestFunction,
    browserTool: BrowserTool,
  ): Promise<TestResult> {
    const cachedTest = await this.cache.get(test);
    this.log.debug("Running cached test", {
      hash: hashData(test),
    });
    this.log.debug("💾", "Executing cached test", { hash: hashData(test) });

    const steps = cachedTest?.data.steps
      // do not take screenshots in cached mode
      ?.filter(
        (step) =>
          step.action?.input.action !== BrowserActionEnum.Screenshot.toString(),
      );

    if (!steps) {
      return {
        test: test,
        status: "failed",
        reason: "No steps to execute, running test in normal mode",
        tokenUsage: { input: 0, output: 0 },
      };
    }
    for (const step of steps) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (
        step.action?.input.action === BrowserActionEnum.MouseMove &&
        // @ts-expect-error Interface and actual values differ
        step.action.input.coordinate
      ) {
        // @ts-expect-error
        const [x, y] = step.action.input.coordinate;

        const componentStr =
          await browserTool.getNormalizedComponentStringByCoords(x, y);

        if (componentStr !== step.extras.componentStr) {
          return {
            test: test,
            status: "failed",
            reason:
              "Component UI elements are different, running test in normal mode",
            tokenUsage: { input: 0, output: 0 },
          };
        }
      }
      if (step.action?.input) {
        try {
          await browserTool.execute(step.action.input);
        } catch (error) {
          this.log.error("Failed to execute step", {
            input: step.action.input,
            ...getErrorDetails(error),
          });
        }
      }
    }

    return {
      test: test,
      status: "passed",
      reason: "All actions successfully replayed from cache",
      tokenUsage: { input: 0, output: 0 },
    };
  }
}
