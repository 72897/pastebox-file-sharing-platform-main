import axios from "axios";

const BASE_URL="pastebox-file-sharing-platform-main.railway.internal/api/"
const axiosInstance=axios.create()

axiosInstance.defaults.baseURL=BASE_URL;

export default axiosInstance;
