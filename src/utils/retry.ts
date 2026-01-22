import chalk from 'chalk';
import pRetry from 'p-retry';

/**
 * Wrap an async function with retry logic.
 * Retries the specified number of times on failure before throwing.
 */
export async function withRetry<T>(
    fn: () => Promise<T>,
    label: string,
    retries: number = 1,
): Promise<T> {
    return pRetry(fn, {
        retries,
        onFailedAttempt: (error) => {
            const errMessage = error.message || String(error) || 'Unknown error';
            console.log(chalk.yellow(`  ${label} failed (attempt ${error.attemptNumber}/${retries + 1}): ${errMessage}`));
        },
    });
}
