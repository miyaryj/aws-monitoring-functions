const AWS = require('aws-sdk');
const moment = require('moment');
const request = require('request');
const fs = require('fs');

const UTC_OFFSET = 540;

async function checkBuckets() {
    const resultsObj = {};

    const s3 = new AWS.S3({ apiVersion: '2006-03-01' });

    let params = {};
    let response = await s3.listBuckets(params).promise();
    if (response.err) {
        console.log(response.err, response.err.stack);
    } else {
        const buckets = response.Buckets.map(b => {
            return {
                name: b.Name
            };
        });
        
        await Promise.all(buckets.map(b => setBucketProperties(s3, b)));
        
        buckets.forEach(b => {
           if (!resultsObj[b.region]) resultsObj[b.region] = [];
           resultsObj[b.region].push(b);
        });
    }

    const results = Object.entries(resultsObj).map(([k, v]) => {
        return { region: k === "undefined" ? undefined : k, buckets: v };
    });
    
    await Promise.all(results.map(r => setBucketsSize(r.region, r.buckets)));
    
    return results;
}

async function setBucketProperties(s3, bucket) {
    try {
        let response = await s3.getBucketLocation({ Bucket: bucket.name }).promise();
        if (response.err) {
            console.log(response.err, response.err.stack);
        } else {
            bucket.region = response.LocationConstraint || "us-east-1";
        }
    } catch (e) {
        console.log("Error in getBucketLocation: " + bucket.name, e);
    }
    
    try {
        let response = await s3.getBucketTagging({ Bucket: bucket.name }).promise();
        if (response.err) {
            console.log(response.err, response.err.stack);
        } else {
            if (response.TagSet && response.TagSet.some(t => t.Key === "Billing")) {
                bucket.billing = response.TagSet.find(t => t.Key === "Billing").Value;
            }
        }
    } catch (e) {
        if (e.name !== "NoSuchTagSet") {
            console.log("Error in getBucketTagging: " + bucket.name, e);
            bucket.billing = e.name;
        }
    }
    
    try {
        let response = await s3.getBucketVersioning({ Bucket: bucket.name }).promise();
        if (response.err) {
            console.log(response.err, response.err.stack);
        } else {
            bucket.versioning = response.Status === "Enabled";
        }
    } catch (e) {
        console.log("Error in getBucketVersioning: " + bucket.name, e);
        bucket.versioning = e.name;
    }
    
    try {
        let response = await s3.getBucketLifecycleConfiguration({ Bucket: bucket.name }).promise();
        if (response.err) {
            console.log(response.err, response.err.stack);
        } else {
            bucket.lifecycleRulesObj = response.Rules;
            bucket.lifecycleRules = response.Rules.filter(r => r.Status === "Enabled").map(r => {
                return Object.keys(r).filter(k => {
                    if (k.endsWith("Expiration")) {
                        return "Date" in r[k] || "Days" in r[k] || "NoncurrentDays" in r[k];
                    } else if (k.endsWith("Transitions")) {
                        return r[k].length;
                    } else if (k === "AbortIncompleteMultipartUpload") {
                        return Object.keys(r[k]).length;
                    } else {
                        return false;
                    }
                }).join("|");
            }).join("|");
        }
    } catch (e) {
        if (e.name !== "NoSuchLifecycleConfiguration") {
            console.log("Error in getBucketLifecycleConfiguration: " + bucket.name, e);
            bucket.lifecycleRules = e.name;
        }
    }
}

async function setBucketsSize(region, buckets) {
    if (!region) return;

    const cloudwatch = new AWS.CloudWatch({ apiVersion: '2010-08-01', region: region });
    const endTime = moment().toDate();
    const startTime = moment().add(-3, "d").toDate();
    
    await Promise.all(buckets.map(b => setBucketSize(cloudwatch, b, startTime, endTime)));
}

async function setBucketSize(cloudwatch, bucket, startTime, endTime) {
    const params = {
        StartTime: startTime,
        EndTime: endTime,
        MetricDataQueries: [{
            Id: "data",
            MetricStat: {
                Metric: {
                    Namespace: "AWS/S3",
                    MetricName: "BucketSizeBytes",
                    Dimensions: [
                        {
                            Name: "BucketName",
                            Value: bucket.name
                        },
                        {
                            Name: "StorageType",
                            Value: "StandardStorage"
                        }
                    ]
                },
                Period: 86400,
                Stat: "Average",
                Unit: "Bytes"
            }
        }]
    };
    const response = await cloudwatch.getMetricData(params).promise();
    if (response.err) {
        console.log(response.err, response.err.stack);
    } else {
        bucket.bucketSizeBytes = response.MetricDataResults[0] ? response.MetricDataResults[0].Values[0] : null;
    }
}

async function putBucketsMpuRules(buckets) {
    const s3 = new AWS.S3({ apiVersion: '2006-03-01' });

    await Promise.all(buckets.map(b => putBucketMpuRules(s3, b)));
}

async function putBucketMpuRules(s3, bucket) {
    const lifecycleRules = bucket.lifecycleRulesObj || [];
    lifecycleRules.forEach(r => {
        if (r.Prefix) {
            r.Filter = { Prefix: r.Prefix };
            delete r.Prefix;
        }
    });
    lifecycleRules.push({
        Expiration: {
            ExpiredObjectDeleteMarker: false
        },
        ID: "aurora-abort-mpu",
        Filter: {},
        Status: "Enabled",
        Transitions: [],
        NoncurrentVersionTransitions: [],
        AbortIncompleteMultipartUpload: {
            DaysAfterInitiation: 7
        }
    });
    const params = {
        Bucket: bucket.name,
        LifecycleConfiguration: {
            Rules: lifecycleRules
        }
    };
    try {
        const response = await s3.putBucketLifecycleConfiguration(params).promise();
        if (response.err) {
            console.log(response.err, response.err.stack);
        }
    } catch (e) {
        console.log("Error in putBucketLifecycleConfiguration: " + bucket.name, e);
    }
}

async function writeToS3(lines) {
    const bucket = process.env['S3_BUCKET'];
    if (!bucket) {
        console.log(`No S3_BUCKET in environment`);
        return;
    }

    await new Promise(function(resolve, reject) {
        fs.writeFile('/tmp/tmp.txt', lines.join('\n'), function(err) {
            if (err) {
                reject(err);
            } else {
                resolve();
            }
        });
    });

    const s3 = new AWS.S3();
    const s3Params = {
        Bucket: bucket,
        Key: `s3/s3_buckets_${moment().format('YYYYMMDDHHmmss')}.csv`,
        Body: fs.readFileSync('/tmp/tmp.txt')
    };
    return s3.putObject(s3Params).promise();
}

async function postToSlack(lines) {
    const url = process.env['SLACK_WEBHOOK_URL'];
    if (!url) {
        console.log(`No SLACK_WEBHOOK_URL in environment`);
        return;
    }

    const options = {
        url: url,
        headers: {
            'Content-type': 'application/json'
        },
        body: {
            "text": lines.join('\n')
        },
        json: true
    };

    return new Promise((resolve, reject) => {
        request.post(options, function(error, response, body) {
            if (!error && response.statusCode == 200) {
                resolve(body);
            } else {
                console.log('error: ' + response.statusCode);
                reject();
            }
        });
    });
}

exports.handler = async (event) => {
    console.log(event);

    const results = await checkBuckets();

    const lines = ['name, billing, versioning, lifecycleRules, bucketSizeBytes, region'];
    const noBillings = [];
    const noMpuRule = [];
    results.filter(result => result.buckets.length > 0).forEach(result => {
        console.log(`${result.region}: ${result.buckets.length}`);
        result.buckets.forEach(b => {
            lines.push([b.name, b.billing, b.versioning, b.lifecycleRules, b.bucketSizeBytes, b.region].join(','));
            if (!b.billing && b.billing !== "AccessDenied") {
                noBillings.push(b);
            }
            if ((!b.lifecycleRules || b.lifecycleRules.split("|").every(r => r !== "AbortIncompleteMultipartUpload")) &&
                    b.billing !== "AccessDenied") {
                noMpuRule.push(b);
            }
        });
    });

    console.log(lines.join('\n'));
    if (event.writeToS3) {
        await writeToS3(lines);
    }

    if (noMpuRule.length > 0) {
        const alertLines = [`S3 buckets with no AbortIncompleteMultipartUpload lifecycleRule found!\n`];
        noMpuRule.forEach(b => {
            alertLines.push(`\`${b.name}\` (billing: ${b.billing}, lifecycleRules: ${b.lifecycleRules}, region: ${b.region})`);
        });
        console.log(alertLines.join('\n'));
        if (event.putMpuRules) {
            await putBucketsMpuRules(noMpuRule);
        }
    }

    const response = {
        statusCode: 200,
        body: JSON.stringify(results),
    };
    return response;
};
