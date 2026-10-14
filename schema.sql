CREATE DATABASE IF NOT EXISTS admission_desk;
USE admission_desk;

CREATE TABLE IF NOT EXISTS students(
  id INT AUTO_INCREMENT PRIMARY KEY,
  roll_no VARCHAR(30) UNIQUE,
  name VARCHAR(100),
  email VARCHAR(120) UNIQUE,
  password_hash VARCHAR(100),
  role ENUM('student','admin') DEFAULT 'student'
);

CREATE TABLE IF NOT EXISTS fees(
  id INT AUTO_INCREMENT PRIMARY KEY,
  student_id INT,
  label VARCHAR(80),
  amount DECIMAL(10,2),
  due_date DATE,
  status ENUM('due','paid') DEFAULT 'due',
  FOREIGN KEY(student_id) REFERENCES students(id)
);

CREATE TABLE IF NOT EXISTS payments(
  id INT AUTO_INCREMENT PRIMARY KEY,
  fee_id INT,
  student_id INT,
  amount DECIMAL(10,2),
  receipt_no VARCHAR(30),
  paid_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tokens(
  id INT AUTO_INCREMENT PRIMARY KEY,
  student_id INT,
  purpose VARCHAR(80),
  slot_date DATE,
  slot_time VARCHAR(5),
  token_no INT,
  status ENUM('waiting','serving','done','cancelled') DEFAULT 'waiting',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS requests(
  id INT AUTO_INCREMENT PRIMARY KEY,
  student_id INT,
  type ENUM('renewal','bonafide','no_dues'),
  status ENUM('submitted','verified','approved','ready') DEFAULT 'submitted',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);