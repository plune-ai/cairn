import React from "react";
import { Box, Text } from "ink";

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * React error boundary (must be a class — hooks can't catch render errors).
 * Keeps a thrown render error from tearing down the whole Ink process; shows it instead.
 */
export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override render(): React.ReactNode {
    if (this.state.error) {
      return (
        <Box flexDirection="column" padding={1}>
          <Text color="red" bold>
            TUI error
          </Text>
          <Text>{this.state.error.message}</Text>
          <Text dimColor>Press Ctrl+C to exit.</Text>
        </Box>
      );
    }
    return this.props.children;
  }
}
