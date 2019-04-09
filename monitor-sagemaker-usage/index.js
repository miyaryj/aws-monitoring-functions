const AWS = require('aws-sdk');
const moment = require('moment');
const request = require('request');
const fs = require('fs');

const REGIONS = [
    'us-east-2',
    'us-east-1',
    'us-west-1',
    'us-west-2',
    'ap-south-1',
    //'ap-northeast-3',
    'ap-northeast-2',
    'ap-southeast-1',
    'ap-southeast-2',
    'ap-northeast-1',
    'ca-central-1',
    //'cn-north-1',
    //'cn-northwest-1',
    'eu-central-1',
    'eu-west-1',
    'eu-west-2',
    // 'eu-west-3', // SageMaker unsupported yet
    // 'eu-north-1', // SageMaker unsupported yet
    // 'sa-east-1', // SageMaker unsupported yet
];

const UTC_OFFSET = 540;

async function checkResources(region) {
    const result = {
        region: region,
        resources: []
    };

    const sagemaker = new AWS.SageMaker({apiVersion: '2017-07-24', region: region});

    // Notebook
    let params = {
        StatusEquals : 'InService'
    };
    let response = await sagemaker.listNotebookInstances(params).promise();
    if (response.err) {
        console.log(response.err, response.err.stack);
    } else {
        result.resources = result.resources.concat(await Promise.all(response.NotebookInstances.map(i => {
            const instance = {
                category: 'notebook',
                name: i.NotebookInstanceName,
                type: i.InstanceType,
                since: i.CreationTime,
                region: region
            };
            return setTags(sagemaker, i.NotebookInstanceArn, instance);
        })));
    }

    // Training
    params = {
        StatusEquals : 'InProgress'
    };
    response = await sagemaker.listTrainingJobs(params).promise();
    if (response.err) {
        console.log(response.err, response.err.stack);
    } else {
        result.resources = result.resources.concat(await Promise.all(response.TrainingJobSummaries.map(j => {
            const job = {
                category: 'training',
                name: j.TrainingJobName,
                // type: j.InstanceType, // TrainingJobSummary doesn't include instanceType
                since: j.CreationTime,
                region: region
            };
            return setTags(sagemaker, j.TrainingJobArn, job);
        })));
    }

    // Endpoint
    params = {
        StatusEquals : 'InService'
    };
    response = await sagemaker.listEndpoints(params).promise();
    if (response.err) {
        console.log(response.err, response.err.stack);
    } else {
        result.resources = result.resources.concat(await Promise.all(response.Endpoints.map(e => {
            const endpoint = {
                category: 'endpoint',
                name: e.EndpointName,
                // type: e.InstanceType, // Endpoint doesn't include instanceType
                since: e.CreationTime,
                region: region
            };
            return setTags(sagemaker, e.EndpointArn, endpoint);
        })));
    }

    return result;
}

async function setTags(sagemaker, arn, target) {
    const params = {
        ResourceArn : arn
    };
    const response = await sagemaker.listTags(params).promise();
    response.Tags.forEach(t => {
        switch (t.Key) {
            case 'Billing':
                target.billing = t.Value;
                break;
        }
    });
    return target;
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
        Key: `sagemaker/sagemaker_resources_${moment().format('YYYYMMDDHHmmss')}.csv`,
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

    const regions = event.regions ? event.regions : REGIONS;
    const results = await Promise.all(regions.map(checkResources));

    const lines = ['category, name, billing, instanceType, since, region'];
    const noBillings = [];
    results.filter(result => result.resources.length > 0).forEach(result => {
        console.log(`${result.region}: ${result.resources.length}`);
        result.resources.forEach(i => {
            lines.push([i.category, i.name, i.billing,i.type, moment(i.since).utcOffset(UTC_OFFSET).format('YYYY/MM/DD'), i.region].join(','));
            if (!i.billing) {
                noBillings.push(i);
            }
        });
    });

    console.log(lines.join('\n'));
    if (event.writeToS3) {
        await writeToS3(lines);
    }

    if (noBillings.length > 0) {
        const alertLines = [`SageMaker resources with no Billing-tag found!\n`];
        noBillings.forEach(i => {
            alertLines.push(`\`${i.name}\` (category: ${i.category}, type: ${i.type}, since: ${moment(i.since).utcOffset(UTC_OFFSET).format('YYYY-MM-DD')}, region: ${i.region})`);
        });
        console.log(alertLines.join('\n'));
        if (event.postToSlack) {
            await postToSlack(alertLines);
        }
    }

    const response = {
        statusCode: 200,
        body: JSON.stringify(results),
    };
    return response;
};
