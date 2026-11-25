import { CfnOutput, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import type { Construct } from "constructs";
import { fileURLToPath } from "node:url";

export interface WebStackProps extends StackProps {
  envName: string;
}

/**
 * Static hosting for the game: a private S3 bucket that only CloudFront can read.
 *
 * Browser ──HTTPS──► CloudFront (edge cache near the player) ──OAC──► S3 (private)
 */
export class WebStack extends Stack {
  constructor(scope: Construct, id: string, props: WebStackProps) {
    super(scope, id, props);

    // Private bucket: nobody on the internet can read it directly (architecture §11).
    const bucket = new s3.Bucket(this, "SiteBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // dev can be torn down completely; prod will keep its data.
      removalPolicy: props.envName === "prod" ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      autoDeleteObjects: props.envName !== "prod",
    });

    // CloudFront reads the bucket through Origin Access Control (OAC), signed requests only.
    const distribution = new cloudfront.Distribution(this, "SiteDistribution", {
      comment: `Sundo game (${props.envName})`,
      defaultRootObject: "index.html",
      // PriceClass 200 includes edge locations in Asia (100 is North America + Europe only).
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
    });

    // Upload the site and clear the CloudFront cache so the new version shows right away.
    new s3deploy.BucketDeployment(this, "DeploySite", {
      sources: [s3deploy.Source.asset(fileURLToPath(new URL("../site", import.meta.url)))],
      destinationBucket: bucket,
      distribution,
      distributionPaths: ["/*"],
    });

    new CfnOutput(this, "SiteUrl", { value: `https://${distribution.distributionDomainName}` });
    new CfnOutput(this, "BucketName", { value: bucket.bucketName });
  }
}
