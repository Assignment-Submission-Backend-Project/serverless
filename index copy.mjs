import AWS from 'aws-sdk';
import axios from 'axios';

// Import statements for AWS SDK v3 (DynamoDB)
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { PutCommand, DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

// Import statement for mailgun
import mailgun from "mailgun-js";

// Import statement for Google Cloud Storage
import { Storage } from '@google-cloud/storage';
// const axios = require('axios');
// const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
// const { PutCommand, DynamoDBDocumentClient } = require("@aws-sdk/lib-dynamodb");
// const mailgun = require("mailgun-js");
// var AWS = require('aws-sdk');
// const { Storage } = require('@google-cloud/storage');
const dbClient = new DynamoDBClient({});
// const docClient = DynamoDBDocumentClient.from(dbClient);

// Set the region 
AWS.config.update({ region: process.env.REGION });

// Create the DynamoDB service object
var docClient = new AWS.DynamoDB.DocumentClient({ apiVersion: '2012-08-10' });


export async function handler(event, context) {
    try {
        let submissionStatus = false;
        let gcsStatus = false;
        let emailStatus = false;

        const snsMessage = JSON.parse(event.Records[0].Sns.Message);

        const { submissionUrl, userEmail, assignmentId, userId } = snsMessage;

        const file = await downloadSubmissionZip(submissionUrl, userEmail);
        if (!file) {
            emailStatus = await sendEmailToUser(userEmail, "fail");
        } else {
            submissionStatus = true;

            [submissionStatus, emailStatus] = await Promise.all([
                uploadToGCS(file, assignmentId, userId),
                sendEmailToUser(userEmail, "success"),
            ]);
        }

        console.info("Status: ", JSON.stringify({
            submissionStatus: submissionStatus,
            gcsStatus: submissionStatus,
            emailStatus: emailStatus,
        }));

        await createEventInDynamoDB(snsMessage);
    } catch (error) {
        console.log('Error in one of the lambda steps:', error);
    }
};

const downloadSubmissionZip = async (submissionUrl, userEmail) => {
    try {
        const response = await axios.get(submissionUrl, { responseType: 'stream' });
        console.log('Downloaded the zip file from URL', JSON.stringify({
            status: response.status,
            url: response.config.url,
        }));
        return response;
    } catch (err) {
        console.log("Error downloading the zip file", err);
        return false;
    }
}

const uploadToGCS = async (submissionFile, assignmentId, userId) => {
    console.log("Uploading zip file to GCS...");
    try {
        const timestamp = new Date().toISOString().replace(/[-:.]/g, '');

        // Create a GCS client
        const storage = new Storage({ keyFilename: "./service-account.json" });

        // GitHub and GCS information
        const gcsFileName = `${assignmentId}/${userId}_${timestamp}.zip`;
        const gcsBucketName = process.env.BUCKET_NAME; // GCS bucket name

        // Upload the file to GCS
        const bucket = storage.bucket(gcsBucketName);
        const file = bucket.file(gcsFileName);
        const writeStream = file.createWriteStream();

        submissionFile.data.pipe(writeStream);

        return new Promise((resolve, reject) => {
            writeStream.on('error', (err) => {
                console.log("Error writing to bucket", err);
                resolve(false);
            });

            writeStream.on('finish', () => {
                console.log("Finished uploading to bucket");
                resolve(true);
            });
        });
    } catch (error) {
        console.log('Error uploading zip to bucket', error);
        return false;
    }
}

const createEventInDynamoDB = async (snsMessage) => {
    console.log("Inserting event to DynamoDB", JSON.stringify(snsMessage));
    try {
        const { submissionUrl, userEmail, assignmentId, userId } = snsMessage;

        const params = {
            TableName: process.env.DYNAMODB_TABLE_NAME,
            Item: {
                'userEmail': userEmail, // Use value directly, not { S: userEmail }
                'submissionUrl': submissionUrl,
            },
        };

        docClient.put(params).promise();

        console.log('Inserted email event to DynamoDB:', JSON.stringify(params.Item));

        return true;
    } catch (err) {
        console.log('Error inserting email event to DynamoDB:', err);
        return false;
    }
};

const sendEmailToUser = async (userEmail, type) => {
    // Replace these with your Mailgun API key and domain
    // const apiKey = "6d5b06a1e42d442f5ae4edb628e5a0cf-30b58138-d41ebe79";
    const apiKey = process.env.API;
    //process.env.EMAIL_API_KEY;
    const domain = "mg.csye6225anirudhv.info";

    //process.env.EMAIL_DOMAIN;

    // Create a Mailgun instance with your API key and domain
    const mg = mailgun({ apiKey, domain });

    // Define the email data
    let data;
    if (type === "success") {
        data = {
            from: "no-reply@mg.csye6225anirudhv.info",
            to: userEmail,
            subject: "Assignment submission accepted",
            text: "Your submission was successfully received and verified. Thank you.",
        };
    } else if (type === "fail") {
        data = {
            from: "no-reply@mg.csye6225anirudhv.info",
            to: userEmail,
            subject: "Assignment submission failed",
            text: "Your submission could not be downloaded. Please verify the URL and resubmit.",
        };
    }

    // Send the email
    return mg.messages().send(data)
        .then(() => {
            console.info("Email sent to", userEmail);
            return true;
        })
        .catch((err) => {
            console.error("Error sending email to", userEmail);
            console.error("Email failed: ", err);
            return true;
        });
};