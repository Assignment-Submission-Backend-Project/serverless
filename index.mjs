import AWS from 'aws-sdk';
import axios from 'axios';
import { v4 as uuid } from 'uuid'
// Import statements for AWS SDK v3 (DynamoDB)
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { PutCommand, DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

// Import statement for mailgun
import mailgun from "mailgun-js";

// Import statement for Google Cloud Storage
import { Storage } from '@google-cloud/storage';
const dbClient = new DynamoDBClient({});

// Set the region 
AWS.config.update({ region: process.env.REGION });

// Create the DynamoDB service object
var docClient = new AWS.DynamoDB.DocumentClient({ region: process.env.REGION, apiVersion: '2012-08-10' });

export async function handler(event, context) {
    try {
        let submissionStatus = false;
        let gcsStatus = false;
        let emailStatus = false;

        const snsMessage = JSON.parse(event.Records[0].Sns.Message);
        const { submissionUrl, userEmail, assignmentId, userId } = snsMessage;
        const fileName = submissionUrl.substring(submissionUrl.lastIndexOf('/') + 1);
        const fileloc = "Assignment - " + assignmentId + " / " + userEmail + " / " + fileName;
        const email_body_success = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
        <meta charset="UTF-8">
        <meta http-equiv="X-UA-Compatible" content="IE=edge">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Submission Successful</title>
        </head>
        <body>
        <p>Hello,</p>
        <p>Your Assignment submission for assignment ID :  ${assignmentId} has cleared.</p>
        <p> <strong>Your URL:</strong> ${submissionUrl} </p>
        <p>Thank you for your submission, good luck.</p>
        <p>Email ID : <br>${userEmail}</p>
        </body>
        </html>
        `;

        const email_body_failure = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
        <meta charset="UTF-8">
        <meta http-equiv="X-UA-Compatible" content="IE=edge">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Submission Failed</title>
        </head>
        <body>
        <p>Hello,</p>
        <p>Your Assignment submission for assignment ID :   ${assignmentId} has failed.</p>
        <p> <strong>Your URL:</strong> ${submissionUrl} </p>
        <p>Revise the submission. Please ensure the link points to a valid downloadable file type.</p>
        <p>Email ID : <br>${userEmail}</p>
        </body>
        </html>
        `;
        const params = {
            TableName: process.env.DYNAMODB_TABLE_NAME,
            Item: {
                Id: Math.floor(Math.random() * 1000000),
                assignment_id: assignmentId,
                email: userEmail,
                timestamp: new Date().toISOString(),
                filePath: fileloc
            },
        };

        await docClient.put(params).promise();

        console.log('Inserted email event to DynamoDB:', JSON.stringify(params.Item));

        const file = await downloadSubmissionZip(submissionUrl, userEmail);
        console.log("downloadSubmissionZip", file)

        let email_text_success = String(userEmail)
        let assignmentId_text = String(assignmentId)
        let userID_text = String(userId)
        let submission_url_text = String(submissionUrl)
        let error_text = String(file.error)

        const gcs_bucket = process.env.BUCKET_NAME;
        let gcs_bucket_text = String(gcs_bucket)

        let message_content = String(`you sumbitted via": ${email_text_success}<p>attempted on assignment id : +${assignmentId_text} , user ID: ${userID_text}, URL submitted: ${submission_url_text}</p>`)

        if (!file.status) {
            //emailStatus = await sendEmailToUser(userEmail, "fail", assignmentId_text, userID_text, submission_url_text);
            emailStatus = await sendEmailToUser(userEmail, "fail", email_body_failure, submission_url_text);
        } else {
            submissionStatus = true;

            [submissionStatus, emailStatus] = await Promise.all([
                uploadToGCS(file, assignmentId, userId, submission_url_text, userEmail),
                sendEmailToUser(userEmail, "success", email_body_success, assignmentId_text)
            ]);

        }

        console.info("Status: ", JSON.stringify({
            submissionStatus: submissionStatus,
            gcsStatus: submissionStatus,
            emailStatus: emailStatus,
        }));

        // await createEventInDynamoDB(snsMessage);
    } catch (error) {
        console.log('Error in one of the lambda steps:', error);
    }
};

const downloadSubmissionZip = async (submissionUrl, userEmail) => {
    try {
        if (submissionUrl.length === 0) {
            return { status: false, error: 'Empty submissionURL' };
        }
        // Check if the submission URL contains any of the specified words
        const allowedExtensions = ['zip', 'pdf', 'txt', 'doc'];
        if (!allowedExtensions.some(extension => submissionUrl.includes(extension))) {
            return { status: false, error: 'Submission URL does not contain allowed file extension' };
        }

        const response = await axios.get(submissionUrl, { responseType: 'stream' });

        //Check if the response is empty or the content length is 0
        if (!response.data || response.headers['content-length'] === '0') {
            console.log('Empty content in the zip file');
            return { status: false, error: 'Empty content in the zip file' };
        }

        console.log('Downloaded the zip file from URL', JSON.stringify({
            status: response.status,
            url: response.config.url,
        }));
        return response;
    } catch (err) {
        console.log("Error downloading the zip file", err);
        return { status: false, error: err };
    }
}
const uploadToGCS = async (submissionFile, assignmentId, userId, submission_url_text, userEmail) => {
    console.log("Uploading zip file to GCS...");
    try {
        const timestamp = new Date().toISOString().replace(/[-:.]/g, '');

        // Create a GCS client
        const storage = new Storage({ keyFilename: "./service-account.json" });

        // Splitting the email address using '@' as the delimiter
        const parts = userEmail.split('@');

        // The first part (index 0) will contain the username
        const username = parts[0];

        // GitHub and GCS information
        const gcsFileName = `${username}/${assignmentId}/${userId}_${timestamp}.zip`;
        console.info(gcsFileName)
        const gcsBucketName = process.env.BUCKET_NAME; // GCS bucket name

        const path = `${gcsBucketName}/${gcsFileName}`;
        console.info(path)

        // Upload the file to GCS
        const bucket = storage.bucket(gcsBucketName);
        const file = bucket.file(gcsFileName);
        const writeStream = file.createWriteStream();

        submissionFile.data.pipe(writeStream);

        return new Promise((resolve, reject) => {
            writeStream.on('error', (err) => {
                console.log("Error writing to bucket", err);
                resolve({ status: false, path: null });
            });

            writeStream.on('finish', () => {
                console.log("Finished uploading to bucket");
                resolve({ status: true, path: path });
            });
        });
    } catch (error) {
        console.log('Error uploading zip to bucket', error);
        resolve({ status: true, path: path });
    }
}

const sendEmailToUser = async (userEmail, type, info, details) => {
    // Replace these with your Mailgun API key and domain

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
            subject: `Assignment submission accepted for assignment id:${details}`,
            to: userEmail,
            subject: "Assignment submission accepted",
            html: `${info}`
        };
    } else if (type === "fail") {
        data = {
            from: "no-reply@mg.csye6225anirudhv.info",
            subject: `Assignment submission failed. Issue with uploading ${details}`,
            to: userEmail,
            subject: "Assignment submission failed",
            html: `${info}`
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