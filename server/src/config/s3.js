import { S3Client } from "@aws-sdk/client-s3";
const minioClient = new S3Client({
  region: process.env.AWS_REGION,
  endpoint: process.env.S3_ENDPOINT,
  forcePathStyle: true,
  credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY }
});
export default minioClient;
