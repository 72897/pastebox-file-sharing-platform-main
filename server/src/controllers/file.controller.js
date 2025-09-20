// src/controllers/file.controller.js
import { File } from '../models/file.models.js';
import { GuestFile } from '../models/guestFile.models.js';
import minioClient from "../config/s3.js"; // S3Client configured with endpoint -> MinIO
import bcrypt from "bcryptjs";
import nodemailer from "nodemailer";
import shortid from "shortid";
import QRCode from "qrcode";
import { User } from '../models/user.models.js';
import path from "path";
import {
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// ---------- Helpers ----------
const buildKey = (fileName) => `file-share-app/${fileName}`;

const publicObjectUrl = (bucket, key) => {
  // For MinIO setup where S3 endpoint is like http://localhost:9000
  const endpoint = (process.env.S3_ENDPOINT || "").replace(/\/$/, "");
  return `${endpoint}/${bucket}/${key}`;
};

const signedDownloadUrl = async (bucket, key, fileName, expiresInSec = 24 * 60 * 60) => {
  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
    ResponseContentDisposition: `attachment; filename="${fileName}"`,
  });
  return await getSignedUrl(minioClient, command, { expiresIn: expiresInSec });
};

// ---------- Upload (logged-in user) ----------
const uploadFiles = async (req, res) => {
  if (!req.files || req.files.length === 0)
    return res.status(400).json({ error: 'No files uploaded' });

  const { isPassword, password, hasExpiry, expiresAt, userId } = req.body;

  try {
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const savedFiles = [];

    for (const file of req.files) {
      // assume multer.memoryStorage => file.buffer exists
      const originalClean = file.originalname.replace(/\s+/g, '_');
      const uniqueSuffix = shortid.generate();
      const ext = path.extname(originalClean) || '';
      const finalFileName = `${originalClean}_${uniqueSuffix}${ext}`;
      const key = buildKey(finalFileName);

      // Upload using AWS SDK v3 command (works against MinIO S3 endpoint)
      const putParams = {
        Bucket: process.env.AWS_BUCKET_NAME,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype,
      };
      await minioClient.send(new PutObjectCommand(putParams));

      const fileUrl = publicObjectUrl(process.env.AWS_BUCKET_NAME, key);
      const shortCode = shortid.generate();

      const fileObj = {
        path: fileUrl,
        name: finalFileName,
        type: file.mimetype,
        size: file.size,
        hasExpiry: hasExpiry === 'true',
        expiresAt:
          hasExpiry === 'true'
            ? new Date(Date.now() + Number(expiresAt) * 3600000)
            : new Date(Date.now() + 10 * 24 * 3600000),
        status: 'active',
        shortUrl: `/f/${shortCode}`,
        createdBy: userId,
      };

      if (isPassword === 'true') {
        fileObj.password = await bcrypt.hash(password, 10);
        fileObj.isPasswordProtected = true;
      }

      const savedFile = await new File(fileObj).save();
      savedFiles.push(savedFile);

      // Update user stats (safe increments)
      user.totalUploads = (user.totalUploads || 0) + 1;
      if (file.mimetype.startsWith('image/')) user.imageCount = (user.imageCount || 0) + 1;
      else if (file.mimetype.startsWith('video/')) user.videoCount = (user.videoCount || 0) + 1;
      else if (file.mimetype.startsWith('application/')) user.documentCount = (user.documentCount || 0) + 1;
    }

    await user.save();

    return res.status(201).json({
      message: "Files uploaded successfully",
      fileIds: savedFiles.map(f => f._id),
    });
  } catch (error) {
    console.error("Upload error:", error);
    return res.status(500).json({ message: "File upload failed", detail: error.message });
  }
};

// ---------- Upload (guest user) ----------
const uploadFilesGuest = async (req, res) => {
  if (!req.files || req.files.length === 0)
    return res.status(400).json({ error: 'No files uploaded' });

  const { isPassword, password, hasExpiry, expiresAt } = req.body;

  try {
    const savedFiles = [];

    for (const file of req.files) {
      const originalClean = file.originalname.replace(/\s+/g, '_');
      const uniqueSuffix = shortid.generate();
      const ext = path.extname(originalClean) || '';
      const finalFileName = `${originalClean}_${uniqueSuffix}${ext}`;
      const key = buildKey(finalFileName);

      const putParams = {
        Bucket: process.env.AWS_BUCKET_NAME,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype,
      };
      await minioClient.send(new PutObjectCommand(putParams));

      const fileUrl = publicObjectUrl(process.env.AWS_BUCKET_NAME, key);
      const shortCode = shortid.generate();
      const username = shortid.generate();

      const fileObj = {
        path: fileUrl,
        name: finalFileName,
        type: file.mimetype,
        size: file.size,
        hasExpiry: hasExpiry === 'true',
        expiresAt:
          hasExpiry === 'true'
            ? new Date(Date.now() + Number(expiresAt) * 3600000)
            : new Date(Date.now() + 10 * 24 * 3600000),
        status: 'active',
        shortUrl: `/g/${shortCode}`,
        createdBy: `guest_${username}`,
      };

      if (isPassword === 'true') {
        fileObj.password = await bcrypt.hash(password, 10);
        fileObj.isPasswordProtected = true;
      }

      const savedFile = await new GuestFile(fileObj).save();
      savedFiles.push(savedFile);
    }

    return res.status(201).json({
      message: "Files uploaded successfully",
      files: savedFiles.map(f => ({
        id: f._id,
        name: f.name,
        size: f.size,
        type: f.type,
        path: f.path,
        isPasswordProtected: f.isPasswordProtected,
        expiresAt: f.expiresAt,
        downloadedContent: f.downloadedContent,
        status: f.status,
        shortUrl: f.shortUrl,
        createdAt: f.createdAt,
        updatedAt: f.updatedAt
      }))
    });
  } catch (error) {
    console.error("Upload error:", error);
    return res.status(500).json({ message: "File upload failed", detail: error.message });
  }
};

// ---------- Download info (user short link) ----------
const downloadInfo = async (req, res) => {
  const { shortCode } = req.params;
  try {
    const file = await File.findOne({ shortUrl: `/f/${shortCode}` });
    if (!file) return res.status(404).json({ error: 'File not found' });
    if (file.status !== 'active') return res.status(403).json({ error: 'This file is not available for download' });
    if (file.expiresAt && new Date(file.expiresAt) < new Date()) {
      file.status = 'expired';
      await file.save();
      return res.status(410).json({ error: 'This file has expired' });
    }

    const key = buildKey(file.name);
    const downloadUrl = await signedDownloadUrl(process.env.AWS_BUCKET_NAME, key, file.name, 24 * 60 * 60);

    file.downloadedContent = (file.downloadedContent || 0) + 1;
    await file.save();

    const user = await User.findById(file.createdBy);
    if (user) {
      user.totalDownloads = (user.totalDownloads || 0) + 1;
      await user.save();
    }

    return res.status(200).json({
      downloadUrl,
      id: file._id,
      name: file.name,
      size: file.size,
      type: file.type || 'file',
      path: file.path,
      isPasswordProtected: file.isPasswordProtected || false,
      expiresAt: file.expiresAt || null,
      status: file.status || 'active',
      shortUrl: file.shortUrl,
      downloadedContent: file.downloadedContent,
      uploadedBy: user?.fullname || 'Unknown',
      createdAt: file.createdAt,
      updatedAt: file.updatedAt
    });
  } catch (error) {
    console.error("Download error:", error);
    return res.status(500).json({ error: 'Internal Server Error', detail: error.message });
  }
};

// ---------- Guest download info ----------
const guestDownloadInfo = async (req, res) => {
  const { shortCode } = req.params;
  try {
    const file = await GuestFile.findOne({ shortUrl: `/g/${shortCode}` });
    if (!file) return res.status(404).json({ error: 'File not found' });
    if (file.status !== 'active') return res.status(403).json({ error: 'This file is not available for download' });
    if (file.expiresAt && new Date(file.expiresAt) < new Date()) {
      file.status = 'expired';
      await file.save();
      return res.status(410).json({ error: 'This file has expired' });
    }

    const key = buildKey(file.name);
    const downloadUrl = await signedDownloadUrl(process.env.AWS_BUCKET_NAME, key, file.name, 24 * 60 * 60);

    file.downloadedContent = (file.downloadedContent || 0) + 1;
    await file.save();

    return res.status(200).json({
      downloadUrl,
      id: file._id,
      name: file.name,
      size: file.size,
      type: file.type || 'file',
      path: file.path,
      isPasswordProtected: file.isPasswordProtected || false,
      expiresAt: file.expiresAt || null,
      status: file.status || 'active',
      shortUrl: file.shortUrl,
      downloadedContent: file.downloadedContent,
      uploadedBy: file.createdBy,
      createdAt: file.createdAt,
      updatedAt: file.updatedAt
    });
  } catch (error) {
    console.error("Guest download error:", error);
    return res.status(500).json({ error: 'Internal Server Error', detail: error.message });
  }
};

// ---------- Download by fileId ----------
const downloadFile = async (req, res) => {
  const { fileId } = req.params;
  const { password } = req.body;

  try {
    const file = await File.findById(fileId);
    if (!file) return res.status(404).json({ error: 'File not found' });
    if (file.status !== 'active') return res.status(403).json({ error: 'This file is not available for download' });
    if (file.expiresAt && new Date(file.expiresAt) < new Date()) return res.status(410).json({ error: 'This file has expired' });

    if (file.isPasswordProtected) {
      if (!password) return res.status(401).json({ error: 'Password required' });
      const isMatch = await bcrypt.compare(password, file.password);
      if (!isMatch) return res.status(403).json({ error: 'Incorrect password' });
    }

    const key = buildKey(file.name);
    const downloadUrl = await signedDownloadUrl(process.env.AWS_BUCKET_NAME, key, file.name, 24 * 60 * 60);

    file.downloadedContent = (file.downloadedContent || 0) + 1;
    await file.save();

    const user = await User.findById(file.createdBy);
    if (user) {
      user.totalDownloads = (user.totalDownloads || 0) + 1;
      await user.save();
    }

    return res.status(200).json({ downloadUrl });
  } catch (error) {
    console.error("Download error:", error);
    return res.status(500).json({ error: 'Internal Server Error', detail: error.message });
  }
};

// ---------- Delete file ----------
const deleteFile = async (req, res) => {
  const { fileId } = req.params;
  try {
    const file = await File.findById(fileId);
    if (!file) return res.status(404).json({ error: 'File not found' });
    if (file.status === 'deleted') return res.status(400).json({ error: 'File already deleted' });

    const key = buildKey(file.name);
    await minioClient.send(new DeleteObjectCommand({
      Bucket: process.env.AWS_BUCKET_NAME,
      Key: key,
    }));

    await File.deleteOne({ _id: fileId });

    return res.status(200).json({ message: 'File deleted successfully' });
  } catch (error) {
    console.error("Delete error:", error);
    return res.status(500).json({ error: 'Internal Server Error', detail: error.message });
  }
};

// ---------- Other non-S3-specific controllers (unchanged) ----------
/* updateFileStatus, updateFileExpiry, updateAllFileExpiry, updateFilePassword,
   searchFiles, showUserFiles, getFileDetails, generateShareShortenLink,
   sendLinkEmail, generateQR, getDownloadCount, resolveShareLink,
   verifyFilePassword, verifyGuestFilePassword, getUserFiles
   (These can remain the same as your original implementations — they only
    need S3 adjustments when they interact with the storage; e.g. sendLinkEmail
    uses signedDownloadUrl above.)
*/

const updateFileStatus = async (req, res) => {
  // ... same as your earlier code (kept for brevity)
  const { fileId } = req.params;
  const { status } = req.body;
  try {
    if (!['active','inactive'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
    const file = await File.findById(fileId);
    if (!file) return res.status(404).json({ error: 'File not found' });
    if (file.status === status) return res.status(400).json({ error: 'File already has this status' });
    file.status = status;
    await file.save();
    return res.status(200).json({ message: 'File status updated successfully' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
};

const updateFileExpiry = async (req, res) => {
  // ... same logic as before
  const { fileId } = req.params;
  const { expiresAt } = req.body;
  try {
    const file = await File.findById(fileId);
    if (!file) return res.status(404).json({ error: 'File not found' });
    if (expiresAt) file.expiresAt = new Date(Date.now() + Number(expiresAt) * 3600000);
    await file.save();
    return res.status(200).json({ message: 'File expiry updated successfully' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
};

const updateAllFileExpiry = async (req, res) => {
  try {
    const files = await File.find();
    if (!files || files.length === 0) return res.status(404).json({ error: 'No files found' });
    const updatedFiles = [];
    for (const file of files) {
      if (file.status === 'deleted') continue;
      if (file.expiresAt && new Date(file.expiresAt) < new Date()) {
        file.status = 'expired';
        file.hasExpiry = true;
      } else {
        file.expiresAt = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
        file.hasExpiry = true;
      }
      await file.save();
      updatedFiles.push(file);
    }
    return res.status(200).json({ message: 'All file expiries updated successfully', files: updatedFiles });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
};

const updateFilePassword = async (req, res) => {
  const { fileId } = req.params;
  const { newPassword } = req.body;
  try {
    const file = await File.findById(fileId);
    if (!file) return res.status(404).json({ error: 'File not found' });
    if (!newPassword) return res.status(400).json({ error: 'New password is required' });
    file.password = await bcrypt.hash(newPassword, 10);
    await file.save();
    return res.status(200).json({ message: 'File password updated successfully' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
};

const searchFiles = async (req, res) => {
  const { query } = req.query;
  try {
    const files = await File.find({ name: { $regex: query, $options: 'i' }});
    if (!files.length) return res.status(404).json({ message: 'No files found' });
    return res.status(200).json(files);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
};

const showUserFiles = async (req, res) => {
  const { userId } = req.params;
  try {
    const files = await File.find({ createdBy: userId });
    if (!files.length) return res.status(404).json({ message: 'No files found' });
    return res.status(200).json(files);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
};

const getFileDetails = async (req, res) => {
  const { fileId } = req.params;
  try {
    const file = await File.findById(fileId);
    if (!file) return res.status(404).json({ message: 'File not found' });
    return res.status(200).json(file);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
};

const generateShareShortenLink = async (req, res) => {
  const { fileId } = req.body;
  try {
    const file = await File.findById(fileId);
    if (!file) return res.status(404).json({ error: 'File not found' });
    const shortCode = shortid.generate();
    file.shortUrl = `${process.env.BASE_URL}/f/${shortCode}`;
    await file.save();
    return res.status(200).json({ shortUrl: file.shortUrl });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
};

const sendLinkEmail = async (req, res) => {
  const { fileId, email } = req.body;
  try {
    const file = await File.findById(fileId);
    if (!file) return res.status(404).json({ error: 'File not found' });

    const key = buildKey(file.name);
    const downloadUrl = await signedDownloadUrl(process.env.AWS_BUCKET_NAME, key, file.name, 24 * 60 * 60);

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS }
    });

    const mailOptions = {
      from: `"File Share App" <${process.env.MAIL_USER}>`,
      to: email,
      subject: 'Your Shared File Link',
      html: `
        <div style="font-family: Arial, sans-serif; line-height: 1.6;">
          <h2>📎 You've received a file!</h2>
          <p><strong>File Name:</strong> ${file.name}</p>
          <p><strong>Size:</strong> ${(file.size / 1024).toFixed(2)} KB</p>
          <p><a href="${downloadUrl}" target="_blank">Click here to download</a></p>
        </div>
      `
    };

    await transporter.sendMail(mailOptions);
    return res.status(200).json({ message: 'Link sent successfully' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
};

const generateQR = async (req, res) => {
  const { fileId } = req.params;
  try {
    const file = await File.findById(fileId);
    if (!file) return res.status(404).json({ error: 'File not found' });
    const key = buildKey(file.name);
    const downloadUrl = await signedDownloadUrl(process.env.AWS_BUCKET_NAME, key, file.name, 24 * 60 * 60);
    const qrDataUrl = await QRCode.toDataURL(downloadUrl);
    return res.status(200).json({ qr: qrDataUrl });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
};

const getDownloadCount = async (req, res) => {
  const { fileId } = req.params;
  try {
    const file = await File.findById(fileId);
    if (!file) return res.status(404).json({ error: 'File not found' });
    return res.status(200).json({ downloadCount: file.downloadedContent || 0 });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
};

const resolveShareLink = async (req, res) => {
  try {
    const { code } = req.params;
    const shortUrl = `${process.env.BASE_URL}/f/${code}`;
    const file = await File.findOne({ shortUrl });
    if (!file) return res.status(404).json({ error: 'Invalid or expired link' });
    if (file.expiresAt && new Date() > file.expiresAt) {
      file.status = 'expired';
      await file.save();
      return res.status(410).json({ error: 'This file has expired.' });
    }
    return res.status(200).json({
      fileId: file._id,
      name: file.name,
      size: file.size,
      type: file.type || 'file',
      previewUrl: file.path,
      isPasswordProtected: file.isPasswordProtected || false,
      expiresAt: file.expiresAt || null,
      status: file.status || 'active',
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
};

const verifyFilePassword = async (req, res) => {
  const { shortCode, password } = req.body;
  try {
    const file = await File.findOne({ shortUrl: `/f/${shortCode}` });
    if (!file || !file.isPasswordProtected) return res.status(400).json({ success: false, error: 'File not protected or not found' });
    const isMatch = await bcrypt.compare(password, file.password);
    if (!isMatch) return res.status(401).json({ success: false, error: 'Incorrect password' });
    return res.status(200).json({ success: true, message: 'Password verified' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
};

const verifyGuestFilePassword = async (req, res) => {
  const { shortCode, password } = req.body;
  try {
    const file = await GuestFile.findOne({ shortUrl: `/g/${shortCode}` });
    if (!file || !file.isPasswordProtected) return res.status(400).json({ success: false, error: 'File not protected or not found' });
    const isMatch = await bcrypt.compare(password, file.password);
    if (!isMatch) return res.status(401).json({ success: false, error: 'Incorrect password' });
    return res.status(200).json({ success: true, message: 'Password verified' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
};

const getUserFiles = async (req, res) => {
  const { userId } = req.params;
  try {
    const files = await File.find({ createdBy: userId });
    if (!files.length) return res.status(404).json({ message: 'No files found' });
    return res.status(200).json(files);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
};

export {
  uploadFiles,
  uploadFilesGuest,
  downloadInfo,
  guestDownloadInfo,
  downloadFile,
  deleteFile,
  updateFileStatus,
  updateFileExpiry,
  updateAllFileExpiry,
  updateFilePassword,
  searchFiles,
  showUserFiles,
  getFileDetails,
  generateShareShortenLink,
  sendLinkEmail,
  generateQR,
  getDownloadCount,
  resolveShareLink,
  verifyFilePassword,
  verifyGuestFilePassword,
  getUserFiles
};
