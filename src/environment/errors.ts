/** The three stages of the environment contract that can fail, each with its own message. */
export type EnvironmentStage = "basic-auth" | "login" | "start-path";

export class EnvironmentError extends Error {
  constructor(
    readonly stage: EnvironmentStage,
    message: string,
  ) {
    super(message);
    this.name = "EnvironmentError";
  }
}

export class BasicAuthRejectedError extends EnvironmentError {
  constructor(message: string) {
    super("basic-auth", message);
    this.name = "BasicAuthRejectedError";
  }
}

export class LoginFailedError extends EnvironmentError {
  constructor(message: string) {
    super("login", message);
    this.name = "LoginFailedError";
  }
}

export class StartPageUnreachableError extends EnvironmentError {
  constructor(message: string) {
    super("start-path", message);
    this.name = "StartPageUnreachableError";
  }
}

/** The environment description itself is wrong (bad file, unset variable). Never carries a secret value. */
export class EnvironmentConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvironmentConfigError";
  }
}
