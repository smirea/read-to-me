import { gcsClient } from './clients';
import { withRetry } from './utils/retry';

/**
 * Upload a file to Google Cloud Storage.
 * @param localPath - Local file path to upload
 * @param gcsPath - Destination path in format "bucket/path/to/file"
 * @param contentType - Optional content type override
 */
export async function uploadToGCS(localPath: string, gcsPath: string, contentType?: string): Promise<void> {
    // Parse gcsPath: first segment is bucket, rest is the object path
    const parts = gcsPath.split('/');
    const bucketName = parts[0];
    const objectPath = parts.slice(1).join('/');

    const bucket = gcsClient.bucket(bucketName);
    await withRetry(
        async () => bucket.upload(localPath, {
            destination: objectPath,
            ...(contentType && { contentType }),
        }),
        `upload ${objectPath}`,
        2,
    );
}

/**
 * Delete all files in a GCS folder (prefix).
 * @param bucketName - The bucket name
 * @param prefix - The folder prefix to delete (e.g., "read-to-me/005_some-title/")
 */
export async function deleteGCSFolder(bucketName: string, prefix: string): Promise<number> {
    const bucket = gcsClient.bucket(bucketName);
    const [files] = await bucket.getFiles({ prefix });

    if (files.length === 0) return 0;

    await Promise.all(files.map(file => file.delete()));
    return files.length;
}
